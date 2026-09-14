/**
 * Ivan's hold, every way: profit target × give-up time × stop × entry -> data/target-sweep.json
 *
 * Run:  node --experimental-strip-types scripts/target-sweep.ts
 * Needs only the local caches left by scripts/early-flags.ts (no purchase).
 *
 * The strategy under test: buy a flagged name, sell at a fixed profit target if
 * it gets there, otherwise give up at a fixed time. Ivan asked (2026-09-14) to
 * sweep the target (3%–30% and none), the give-up time (09:45 to the close), with
 * and without a stop, entering either at the 08:45 flag price or at the open.
 *
 * A sweep this size (576 settings) will produce "winners" by luck alone, so:
 * - settings are chosen on Aug 2024 – Dec 2025 and JUDGED on 2026, which the
 *   choice never saw;
 * - every mean carries a 95% range from resampling whole mornings;
 * - the number of settings that are positive in-sample AND out-of-sample is
 *   reported against the number expected by chance.
 * Fills: buys at the ask, targets are limits filled when a bar trades through,
 * stops and timed exits take the bid. Management starts the bar after the entry.
 */
import { readFile, writeFile } from 'node:fs/promises';

type Bar = [number, number, number, number, number, number];
type Quote = [number, number | null, number | null];

const FULL_DAY = ['data/db/minutes', 'data/db/strategy-bars'];
const QUOTES = 'data/db/early-quotes';
const OUT = 'data/target-sweep.json';
const ENTRIES: [string, number][] = [['08:45 flag', 525], ['09:30 open', 570]];
const TARGETS = [0.03, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20, 0.30, Infinity];
const EXITS: [string, number][] = [['09:45', 585], ['10:00', 600], ['10:30', 630], ['11:00', 660], ['noon', 720], ['13:00', 780], ['14:00', 840], ['close', 960]];
const STOPS = [Infinity, 0.05, 0.10, 0.20];
const IN_SAMPLE_END = '2025-12-31';
const MAX_SPREAD = 0.2;
const FALLBACK_HALF_SPREAD = 0.005;

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
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? '   —  ' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`.padStart(6));

type Setting = { entry: string; target: number; exit: string; stop: number };
const key = (s: Setting) => `${s.entry} · target ${s.target === Infinity ? 'none' : `${(s.target * 100).toFixed(1)}%`} · out at ${s.exit} · stop ${s.stop === Infinity ? 'none' : `${(s.stop * 100).toFixed(0)}%`}`;

async function main() {
  const sample = (JSON.parse(await readFile('data/early-flags.json', 'utf8')).trades as any[]).filter((t) => t.flag === '08:45');
  const byDate = new Map<string, string[]>();
  for (const t of sample) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t.symbol);

  // returns[settingKey] = list of {date, ret}
  const settings: Setting[] = [];
  for (const [entry] of ENTRIES) for (const target of TARGETS) for (const [exit] of EXITS) for (const stop of STOPS) settings.push({ entry, target, exit, stop });
  const returns = new Map<string, { date: string; ret: number }[]>(settings.map((s) => [key(s), []]));
  let scored = 0;

  for (const [date, symbols] of byDate) {
    const off = nyOffsetMin(date);
    const full: Record<string, Bar[]> = {};
    for (const dir of FULL_DAY) Object.assign(full, await readJson<Record<string, Bar[]>>(`${dir}/${date}.json`, {}));
    const quotes = await readJson<Record<string, Quote[]>>(`${QUOTES}/${date}.json`, {});
    for (const symbol of symbols) {
      const bars = dedupe(full[symbol] ?? []);
      if (!bars.length) continue;
      const minutes = bars.map((b) => nyMinute(b[0], off));
      const qs = quotes[symbol];
      const half = (minute: number, ref: number) => { const q = quoteAt(qs, nyMs(date, minute)); return q && q.ask - q.bid <= MAX_SPREAD * ref && Math.abs((q.ask + q.bid) / 2 / ref - 1) <= MAX_SPREAD ? (q.ask - q.bid) / 2 : ref * FALLBACK_HALF_SPREAD; };
      const openIdx = minutes.findIndex((m) => m >= 570);
      if (openIdx < 0 || minutes[openIdx] !== 570) continue;
      scored++;

      for (const [entryName, entryMinute] of ENTRIES) {
        let entryIdx: number, buy: number;
        if (entryMinute === 525) {
          entryIdx = minutes.reduce((best, m, i) => (m >= 240 && m <= 525 ? i : best), -1);
          if (entryIdx < 0) continue;
          buy = bars[entryIdx][4] + half(526, bars[entryIdx][4]);
        } else { entryIdx = openIdx; buy = bars[openIdx][1] + half(571, bars[openIdx][1]); }

        // First bar (after entry) through each target, and through each stop, with the stop's fill.
        const firstAbove = TARGETS.map((t) => { if (t === Infinity) return Infinity; for (let i = entryIdx + 1; i < bars.length && minutes[i] < 960; i++) if (bars[i][2] > buy * (1 + t)) return i; return Infinity; });
        const firstBelow = STOPS.map((s) => { if (s === Infinity) return { idx: Infinity, fill: NaN }; const lvl = buy * (1 - s); for (let i = entryIdx + 1; i < bars.length && minutes[i] < 960; i++) if (bars[i][3] <= lvl) return { idx: i, fill: Math.min(lvl, bars[i][1]) - half(minutes[i], lvl) }; return { idx: Infinity, fill: NaN }; });
        const exitAt = EXITS.map(([, m]) => { const k = minutes.reduce((best, mm, i) => (mm < m && i > entryIdx ? i : best), entryIdx); const idx = minutes.findIndex((mm) => mm >= m); return { idx: idx < 0 ? Infinity : idx, bid: bars[k][4] - half(m, bars[k][4]) }; });

        TARGETS.forEach((t, ti) => EXITS.forEach(([exitName], ei) => STOPS.forEach((s, si) => {
          const tIdx = firstAbove[ti], sIdx = firstBelow[si].idx, eIdx = exitAt[ei].idx;
          let ret: number;
          if (sIdx <= tIdx && sIdx < eIdx) ret = firstBelow[si].fill / buy - 1;          // stop first (a tie goes to the stop)
          else if (tIdx < eIdx) ret = t;
          else ret = exitAt[ei].bid / buy - 1;
          returns.get(key({ entry: entryName, target: t, exit: exitName, stop: s }))!.push({ date, ret });
        })));
      }
    }
  }
  console.log(`${scored} stock-days over ${byDate.size} sessions; ${settings.length} settings`);

  const summarize = (rows: { date: string; ret: number }[]) => {
    const r = rows.map((x) => x.ret);
    const gains = r.filter((x) => x > 0).reduce((a, b) => a + b, 0), losses = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    const inS = rows.filter((x) => x.date <= IN_SAMPLE_END).map((x) => x.ret), outS = rows.filter((x) => x.date > IN_SAMPLE_END).map((x) => x.ret);
    const byDate = new Map<string, number[]>();
    for (const x of rows) (byDate.get(x.date) ?? byDate.set(x.date, []).get(x.date)!).push(x.ret);
    const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
    for (let i = 0; i < 1000; i++) { let s = 0, c = 0; for (let j = 0; j < days.length; j++) for (const v of days[Math.floor(rnd() * days.length)]) { s += v; c++; } means.push(s / c); }
    means.sort((a, b) => a - b);
    return { trades: r.length, winRate: r.filter((x) => x > 0).length / r.length, mean: mean(r), meanCi95: [means[25], means[974]], profitFactor: losses ? gains / losses : null, inSample: mean(inS), outOfSample: mean(outS), inSampleTrades: inS.length, outOfSampleTrades: outS.length };
  };
  const results = settings.map((s) => ({ ...s, key: key(s), ...summarize(returns.get(key(s))!) }));

  // Grids: mean return per trade, no stop.
  for (const [entryName] of ENTRIES) {
    console.log(`\nMean per trade, entry at the ${entryName}, no stop — rows: profit target, columns: give-up time`);
    console.log(`${'target'.padEnd(8)}${EXITS.map(([e]) => e.padStart(7)).join('')}`);
    for (const t of TARGETS) console.log(`${(t === Infinity ? 'none' : `${(t * 100).toFixed(1)}%`).padEnd(8)}${EXITS.map(([e]) => ` ${pct(results.find((r) => r.entry === entryName && r.target === t && r.exit === e && r.stop === Infinity)!.mean)}`).join('')}`);
  }
  console.log(`\nWith stops (entry at the 08:45 flag), mean per trade — rows: stop, columns: give-up time, at the best no-stop target per column`);
  for (const s of STOPS) console.log(`${(s === Infinity ? 'none' : `${(s * 100).toFixed(0)}%`).padEnd(8)}${EXITS.map(([e]) => { const best = results.filter((r) => r.entry === '08:45 flag' && r.exit === e && r.stop === s).sort((a, b) => b.mean - a.mean)[0]; return ` ${pct(best.mean)}`; }).join('')}`);

  // Selection discipline.
  const positiveIn = results.filter((r) => r.inSample > 0);
  const positiveBoth = positiveIn.filter((r) => r.outOfSample > 0);
  const positiveCi = results.filter((r) => r.meanCi95[0] > 0);
  console.log(`\n${results.length} settings: ${positiveIn.length} positive in-sample (Aug 2024 – Dec 2025), of which ${positiveBoth.length} also positive in 2026; ${positiveCi.length} with the whole 95% range above zero.`);
  console.log('\nTop 10 by in-sample mean, judged on 2026:');
  console.log(`${'setting'.padEnd(62)}${'trades'.padStart(7)}${'won'.padStart(6)}${'in-sample'.padStart(11)}${'2026'.padStart(8)}${'  95% range (all)'.padEnd(20)}${'PF'.padStart(5)}`);
  for (const r of [...results].sort((a, b) => b.inSample - a.inSample).slice(0, 10)) {
    console.log(`${r.key.padEnd(62)}${String(r.trades).padStart(7)}${`${(r.winRate * 100).toFixed(0)}%`.padStart(6)}${pct(r.inSample).padStart(11)}${pct(r.outOfSample).padStart(8)}  ${`${pct(r.meanCi95[0]).trim()} … ${pct(r.meanCi95[1]).trim()}`.padEnd(18)}${(r.profitFactor?.toFixed(2) ?? '—').padStart(5)}`);
  }
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), sample: { stockDays: scored, sessions: byDate.size }, inSampleEnd: IN_SAMPLE_END, results }));
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
