/**
 * When do the flagged stocks make their high, and does a no-stop, take-profit hold
 * capture it? -> data/high-timing.json
 *
 * Run:  node --experimental-strip-types scripts/high-timing.ts
 * Needs only the local caches left by scripts/early-flags.ts (no purchase).
 *
 * Ivan's question (2026-09-14): the flagged names barely gain from the flag price
 * to the open, noon or close, yet their high of the day is far above it — so WHEN
 * does that high happen, and would "buy at the flag, no stop, sell at +20% if it
 * gets there, otherwise out at noon (or the close)" capture it?
 *
 * Sample: every stock the 08:45 gate flagged (up 10%+ on the previous close, 50k+
 * shares, $2–$20), 530 sessions, from its own 1-minute bars. Buys pay the ask at
 * 08:46; the profit target is a limit that fills only when a bar trades through
 * it; timed exits take the bid. Management starts the bar after the buy.
 */
import { readFile, writeFile } from 'node:fs/promises';

type Bar = [number, number, number, number, number, number];
type Quote = [number, number | null, number | null];

const FULL_DAY = ['data/db/minutes', 'data/db/strategy-bars'];
const QUOTES = 'data/db/early-quotes';
const OUT = 'data/high-timing.json';
const FLAG_MINUTE = 525;             // 08:45 ET
const TARGETS = [10, 20, 30];
const EXITS: [string, number][] = [['noon', 720], ['close', 960]];
const MAX_SPREAD = 0.2;
const FALLBACK_HALF_SPREAD = 0.005;
const BUCKETS: [string, number, number][] = [
  ['08:46–09:29 (still pre-market)', 526, 570], ['09:30–09:44', 570, 585], ['09:45–09:59', 585, 600],
  ['10:00–10:29', 600, 630], ['10:30–10:59', 630, 660], ['11:00–11:59', 660, 720], ['12:00–12:59', 720, 780],
  ['13:00–13:59', 780, 840], ['14:00–14:59', 840, 900], ['15:00–15:59', 900, 960],
];

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
const nyMinute = (ts: number, off: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
function dedupe(bars: Bar[]): Bar[] { const out: Bar[] = []; for (const b of [...bars].sort((a, c) => a[0] - c[0])) if (!out.length || out[out.length - 1][0] !== b[0]) out.push(b); return out; }
function quoteAt(qs: Quote[] | undefined, t: number): { bid: number; ask: number } | null {
  if (!qs?.length) return null;
  let lo = 0, hi = qs.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (qs[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0 || t - qs[k][0] > 30 * 60_000) return null;
  const [, bid, ask] = qs[k];
  return bid != null && ask != null && bid > 0 && ask >= bid ? { bid, ask } : null;
}
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

type Row = {
  date: string; symbol: string; flag: number; buy: number; open: number;
  highPct: number; highMinute: number; firstTouch: Record<string, number | null>;
  ret: Record<string, number>;
};

function summarize(rows: Row[], key: string) {
  const r = rows.map((x) => x.ret[key]);
  const gains = r.filter((x) => x > 0).reduce((a, b) => a + b, 0), losses = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const byDate = new Map<string, number[]>();
  for (const x of rows) (byDate.get(x.date) ?? byDate.set(x.date, []).get(x.date)!).push(x.ret[key]);
  const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
  for (let i = 0; i < 2000; i++) { let s = 0, c = 0; for (let j = 0; j < days.length; j++) for (const v of days[Math.floor(rnd() * days.length)]) { s += v; c++; } means.push(s / c); }
  means.sort((a, b) => a - b);
  // 5% of one account in every flagged name, each morning; names on a day share the day.
  let equity = 1, top = 1, dd = 0;
  for (const d of [...byDate.keys()].sort()) { for (const v of byDate.get(d)!) equity *= 1 + 0.05 * v; top = Math.max(top, equity); dd = Math.max(dd, 1 - equity / top); }
  const byYear: Record<string, number> = {};
  for (const y of [...new Set(rows.map((x) => x.date.slice(0, 4)))].sort()) byYear[y] = mean(rows.filter((x) => x.date.startsWith(y)).map((x) => x.ret[key]));
  return { trades: r.length, winRate: r.filter((x) => x > 0).length / r.length, mean: mean(r), median: median(r), meanCi95: [means[50], means[1949]], profitFactor: losses ? gains / losses : null, worst: Math.min(...r), account5pct: equity - 1, maxDrawdown5pct: dd, byYear };
}

async function main() {
  const sample = (JSON.parse(await readFile('data/early-flags.json', 'utf8')).trades as any[]).filter((t) => t.flag === '08:45');
  const byDate = new Map<string, string[]>();
  for (const t of sample) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t.symbol);
  const rows: Row[] = [];
  let noFullDay = 0;
  for (const [date, symbols] of byDate) {
    const off = nyOffsetMin(date);
    const full: Record<string, Bar[]> = {};
    for (const dir of FULL_DAY) Object.assign(full, await readJson<Record<string, Bar[]>>(`${dir}/${date}.json`, {}));
    const quotes = await readJson<Record<string, Quote[]>>(`${QUOTES}/${date}.json`, {});
    for (const symbol of symbols) {
      const bars = dedupe(full[symbol] ?? []);
      if (!bars.length) { noFullDay++; continue; }
      const minutes = bars.map((b) => nyMinute(b[0], off));
      const flagIdx = minutes.reduce((best, m, i) => (m >= 240 && m <= FLAG_MINUTE ? i : best), -1);
      const openIdx = minutes.findIndex((m) => m >= 570);
      if (flagIdx < 0 || openIdx < 0) { noFullDay++; continue; }
      const flag = bars[flagIdx][4];
      const qs = quotes[symbol];
      const half = (minute: number, ref: number) => { const q = quoteAt(qs, nyMs(date, minute)); return q && q.ask - q.bid <= MAX_SPREAD * ref && Math.abs((q.ask + q.bid) / 2 / ref - 1) <= MAX_SPREAD ? (q.ask - q.bid) / 2 : ref * FALLBACK_HALF_SPREAD; };
      const buy = flag + half(FLAG_MINUTE + 1, flag);

      // The high after the flag, and when each run level is first traded through.
      let highPct = -Infinity, highMinute = FLAG_MINUTE;
      const firstTouch: Record<string, number | null> = Object.fromEntries(TARGETS.map((t) => [String(t), null]));
      for (let i = flagIdx + 1; i < bars.length && minutes[i] < 960; i++) {
        const h = bars[i][2] / flag - 1;
        if (h > highPct) { highPct = h; highMinute = minutes[i]; }
        for (const t of TARGETS) if (firstTouch[String(t)] === null && bars[i][2] > flag * (1 + t / 100)) firstTouch[String(t)] = minutes[i];
      }
      const sellAt = (minute: number) => { const k = minutes.reduce((best, m, i) => (m < minute ? i : best), openIdx); return bars[k][4] - half(minute, bars[k][4]); };

      // The strategy: no stop; a limit at +target on the buy price; otherwise out at the exit time.
      const ret: Record<string, number> = {};
      for (const [exitName, exitMinute] of EXITS) {
        ret[`hold → ${exitName}`] = sellAt(exitMinute) / buy - 1;
        for (const t of TARGETS) {
          const level = buy * (1 + t / 100);
          let hit = false;
          for (let i = flagIdx + 1; i < bars.length && minutes[i] < exitMinute; i++) if (bars[i][2] > level) { hit = true; break; }
          ret[`+${t}% target → ${exitName}`] = hit ? t / 100 : sellAt(exitMinute) / buy - 1;
        }
        // Half at +10%, half at +20%; whatever is left goes at the exit.
        let hit10 = false, hit20 = false;
        for (let i = flagIdx + 1; i < bars.length && minutes[i] < exitMinute; i++) { if (bars[i][2] > buy * 1.1) hit10 = true; if (bars[i][2] > buy * 1.2) { hit20 = true; break; } }
        const rest = sellAt(exitMinute) / buy - 1;
        ret[`half +10%, half +20% → ${exitName}`] = hit20 ? 0.15 : hit10 ? 0.05 + 0.5 * rest : rest;
      }
      rows.push({ date, symbol, flag, buy: +buy.toFixed(4), open: bars[openIdx][1], highPct, highMinute, firstTouch, ret });
    }
  }
  console.log(`${rows.length} flagged stock-days scored (${noFullDay} without a full day of bars)`);

  // 1. Where the high of the day lands, from the flag onward.
  const share = (xs: Row[], a: number, b: number) => xs.filter((x) => x.highMinute >= a && x.highMinute < b).length / xs.length;
  const runners = rows.filter((x) => x.highPct >= 0.2);
  console.log(`\nHigh after the flag: median ${pct(median(rows.map((x) => x.highPct)))}; ${pct(runners.length / rows.length)} of names reach +20% above the flag price at some point.`);
  console.log(`${'high of the day falls in'.padEnd(34)}${'all names'.padStart(10)}${'names that ran 20%+'.padStart(21)}`);
  for (const [name, a, b] of BUCKETS) console.log(`${name.padEnd(34)}${(share(rows, a, b) * 100).toFixed(0).padStart(9)}%${(share(runners, a, b) * 100).toFixed(0).padStart(20)}%`);

  // 2. When a +20% run is FIRST reached — what a limit order needs.
  const touched = rows.filter((x) => x.firstTouch['20'] !== null);
  console.log(`\nOf the ${touched.length} names that trade 20% above the flag price, the level is first reached:`);
  for (const [name, m] of [['before the open (09:30)', 570], ['by 09:45', 585], ['by 10:00', 600], ['by 10:30', 630], ['by 11:00', 660], ['by noon', 720], ['by 14:00', 840], ['by the close', 960]] as [string, number][]) {
    console.log(`  ${name.padEnd(26)}${(100 * touched.filter((x) => (x.firstTouch['20'] as number) < m).length / touched.length).toFixed(0).padStart(4)}%`);
  }

  // 3. The strategy.
  const keys = Object.keys(rows[0].ret);
  const results = keys.map((k) => ({ strategy: k, ...summarize(rows, k) }));
  console.log(`\n${'buy at the 08:45 ask, no stop'.padEnd(34)}${'won'.padStart(6)}${'median'.padStart(8)}${'mean'.padStart(7)}  ${'95% range of mean'.padEnd(17)}${'PF'.padStart(5)}${'worst'.padStart(7)}${'5%/trade, 2y'.padStart(14)}${'max DD'.padStart(8)}`);
  for (const r of results) console.log(`${r.strategy.padEnd(34)}${(r.winRate * 100).toFixed(0).padStart(5)}%${pct(r.median).padStart(8)}${pct(r.mean).padStart(7)}  ${`${pct(r.meanCi95[0])} … ${pct(r.meanCi95[1])}`.padEnd(17)}${(r.profitFactor?.toFixed(2) ?? '—').padStart(5)}${pct(r.worst).padStart(7)}${pct(r.account5pct).padStart(14)}${pct(-r.maxDrawdown5pct).padStart(8)}`);
  console.log('\nBy year (mean per trade): ' + results.filter((r) => /target → close|hold → close|\+20% target → noon/.test(r.strategy)).map((r) => `${r.strategy}: ${Object.entries(r.byYear).map(([y, v]) => `${y} ${pct(v as number)}`).join(', ')}`).join('\n                          '));

  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), sample: { stockDays: rows.length, sessions: byDate.size, noFullDay }, highBuckets: BUCKETS.map(([name, a, b]) => ({ bucket: name, all: share(rows, a, b), runners: share(runners, a, b) })), results, rows }));
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
