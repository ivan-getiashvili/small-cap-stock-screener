/**
 * Score every recorded name whose session has closed -> data/history.json
 *
 * Run:  npm run history:fill     (CI runs it after the close, and each morning)
 *
 * The session's bar comes from Nasdaq's daily history. The 12:00 ET price needs
 * intraday data: Nasdaq's chart, which shows the current day only, so CI fills
 * it on the evening of the session. For past days (the replayed mornings) the
 * price comes from the local Databento minute-bar caches when DATABENTO_KEY is
 * set, buying the odd missing symbol for a fraction of a cent.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getBars, getIntraday } from '../lib/sources/nasdaq.ts';
import { loadHistory, saveHistory, fillPerformance, nyToday, type NoonSource } from '../lib/history.ts';

type Minute = [number, number, number, number, number, number];   // ts ms, open, high, low, close, volume
const CACHES = ['data/db/minutes', 'data/db/strategy-bars'];

/** Minutes to add to New York wall-clock time to get UTC, on this date. */
function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, hh: number, mm: number) => Date.parse(`${date}T00:00:00Z`) + (hh * 60 + mm + nyOffsetMin(date)) * 60_000;

/** Today only: the last print at or before 12:00 ET on Nasdaq's chart. */
const nasdaqNoon: NoonSource = async (symbol, date) => {
  if (date !== nyToday()) return undefined;
  const chart = await getIntraday(symbol);
  if (chart.date !== date || !chart.points.length) return undefined;   // not this session, or throttled: try later
  const last = chart.points.filter((p) => p.ts <= nyMs(date, 12, 0)).at(-1);
  return last ? last.price : null;
};

/** Past days: the close of the last regular-session minute before 12:00 ET. */
const databentoNoon: NoonSource = async (symbol, date) => {
  let bars: Minute[] | undefined;
  for (const dir of CACHES) {
    try { bars = JSON.parse(await readFile(`${dir}/${date}.json`, 'utf8'))[symbol]; } catch { /* no file */ }
    if (bars) break;
  }
  if (!bars) {
    const db = await import('../lib/sources/databento.ts');
    const start = new Date(nyMs(date, 4, 0)).toISOString(), end = new Date(nyMs(date, 16, 0)).toISOString();
    bars = [];
    for await (const b of db.streamBars({ dataset: db.MINUTE_DATASET, symbols: [symbol], schema: 'ohlcv-1m', start, end })) {
      bars.push([b.ts, b.open, b.high, b.low, b.close, b.volume]);
    }
    const path = `${CACHES[1]}/${date}.json`;
    let day: Record<string, Minute[]> = {};
    try { day = JSON.parse(await readFile(path, 'utf8')); } catch { await mkdir(CACHES[1], { recursive: true }); }
    day[symbol] = bars;
    await writeFile(path, JSON.stringify(day));
  }
  const off = nyOffsetMin(date);
  const minute = (ts: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
  const before = bars.filter((b) => minute(b[0]) >= 570 && minute(b[0]) < 720).at(-1);
  return before ? before[4] : null;
};

const getNoon: NoonSource = (symbol, date) =>
  date === nyToday() ? nasdaqNoon(symbol, date)
  : process.env.DATABENTO_KEY ? databentoNoon(symbol, date)
  : Promise.resolve(undefined);

const h = await loadHistory();
const names = () => Object.values(h.days).flatMap((d) => d.names);
const unscored = names().filter((n) => !n.performance).length;
const noonBefore = names().filter((n) => n.performance?.noon !== undefined).length;
const filled = await fillPerformance(h, getBars, 80, getNoon);
await saveHistory(h);
const noonAfter = names().filter((n) => n.performance?.noon !== undefined).length;
console.log(`History: scored ${filled} of ${unscored} unscored names, noon price for ${noonAfter - noonBefore} more, across ${Object.keys(h.days).length} days`);
