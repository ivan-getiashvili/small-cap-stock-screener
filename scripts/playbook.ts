/**
 * The momentum source's playbook, applied mechanically -> data/playbook.json
 *
 * Run:  node --experimental-strip-types scripts/playbook.ts [--dry]
 * Needs DATABENTO_KEY and the caches left by scripts/early-flags.ts.
 *
 * Ivan's request (2026-09-14): "Apply their exact playbook. Their stops, their
 * 2:1, maybe re-enter. Show me whether there is an edge." The rules come from
 * docs/CRITERIA.md, in the source's own words, and nothing is tuned:
 *
 *   Entries (1-minute chart)
 *   - Gap and Go, 09:30–10:00 only: the stock gapped 4%+, buy the break of the
 *     high of the first 1-minute candle; stop at that candle's low.
 *   - Gap and Go, pre-market-high version: buy the break of the pre-market high
 *     in the same window; stop at the low of the candle before the break.
 *   - First pullback / bull flag, 07:00–11:00: after a pole of 3+ green candles
 *     gaining 3%+, a pullback of 1–3 candles that never gives back half the
 *     pole, then the first candle to make a new high over the previous candle;
 *     stop at the pullback low. Up to three trades per stock per morning.
 *   Stops: as above, but never more than 20 cents below the entry.
 *   Targets: 2:1. Either all out at 2R, or half at 2R, stop to breakeven, and
 *     the rest out on the first red candle close or when the 1-minute MACD
 *     histogram turns negative. Everything is flat by 11:00 ET.
 *   Size: $500 of risk per trade (shares = 500 / stop distance), never more
 *     than a quarter of the entry minute's volume.
 *
 * What keeps it honest:
 * 1. The sample is every small cap that met the live gate (up 10%+, 50k+
 *    shares, $2–$20) at some minute before 08:45, replayed from its own bars —
 *    the same 7,554 stock-days as early-flags.json. A stock can only be traded
 *    from the minute it qualified: you cannot trade what you have not seen yet.
 * 2. Entries fill at the trigger (or the bar's open if it gapped through) plus
 *    the real half-spread at that minute; stops fill at the stop (or the open if
 *    the bar gapped below) minus the half-spread; targets are limits, filled
 *    only when the bar trades through them. $0.005 a share each way.
 * 3. Management starts on the bar AFTER the entry bar — the order of prices
 *    inside a minute is unknown. If one later bar reaches both the stop and the
 *    target, the stop is taken. That ambiguity is counted and reported.
 * 4. No catalyst or float check for these two years (see CLAUDE.md), so this is
 *    the broad gate, not the strict shortlist.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { streamBars, getCost, batches, MINUTE_DATASET } from '../lib/sources/databento.ts';

type Bar = [number, number, number, number, number, number];   // ts ms, open, high, low, close, volume
type Quote = [number, number | null, number | null];
type Daily = { date: string; close: number };

const FULL_DAY = ['data/db/minutes', 'data/db/strategy-bars'];
const PRE = 'data/db/allsym-premarket';
const GAP = 'data/db/early-gap-bars';
const REG = 'data/db/early-bars';
const QUOTES = 'data/db/early-quotes';
const OUT = 'data/playbook.json';
const DRY = process.argv.includes('--dry');
const CONCURRENCY = 4;

const RISK_USD = 500;
const COMMISSION_PER_SHARE = 0.005;
const STOP_CAP = 0.20;
const TARGET_R = 2;
const WINDOW = { start: 420, end: 660 };     // 07:00–11:00 ET
const GAP_AND_GO = { start: 570, end: 600 };  // 09:30–10:00 ET
const MIN_GAP_PCT = 4;
const POLE = { minBars: 3, minPct: 3 };
const MAX_FLAG_BARS = 3;
const MAX_TRADES_PER_DAY = 3;
const LIQUIDITY_CAP = 0.25;
const MIN_SHARES = 100;
const MAX_SPREAD = 0.2;
const FALLBACK_HALF_SPREAD = 0.005;

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
const nyMinute = (ts: number, off: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
function dedupe(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of [...bars].sort((a, c) => a[0] - c[0])) if (!out.length || out[out.length - 1][0] !== b[0]) out.push(b);
  return out;
}
function quoteAt(qs: Quote[] | undefined, t: number): { bid: number; ask: number } | null {
  if (!qs?.length) return null;
  let lo = 0, hi = qs.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (qs[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0 || t - qs[k][0] > 30 * 60_000) return null;
  const [, bid, ask] = qs[k];
  return bid != null && ask != null && bid > 0 && ask >= bid ? { bid, ask } : null;
}
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/** MACD(12, 26, 9) histogram on closes, standard EMAs. */
function macdHistogram(closes: number[]): number[] {
  const ema = (n: number) => { const k = 2 / (n + 1); let e = closes[0]; return closes.map((c, i) => (e = i ? c * k + e * (1 - k) : c)); };
  const fast = ema(12), slow = ema(26), macd = fast.map((f, i) => f - slow[i]);
  const k = 2 / 10; let s = macd[0];
  return macd.map((m, i) => { s = i ? m * k + s * (1 - k) : m; return m - s; });
}

type Trade = {
  date: string; symbol: string; setup: string; mode: 'all out at 2R' | 'half at 2R, trail';
  entryMinute: number; exitMinute: number; entry: number; stop: number; shares: number;
  rGross: number; rNet: number; pnlUsd: number; exit: string; ambiguous: boolean;
};

type Day = { date: string; symbol: string; bars: Bar[]; minutes: number[]; hist: number[]; qs: Quote[] | undefined; prevClose: number; inPlay: number; off: number };

/** Half the quoted spread at that minute, or a fallback fraction of the price. */
function halfSpread(day: Day, minute: number, ref: number): number {
  const q = quoteAt(day.qs, nyMs(day.date, minute + 1));
  if (q && q.ask - q.bid <= MAX_SPREAD * ref && Math.abs((q.ask + q.bid) / 2 / ref - 1) <= MAX_SPREAD) return (q.ask - q.bid) / 2;
  return ref * FALLBACK_HALF_SPREAD;
}

/** Enter at bar i and manage from bar i+1. Returns null when the trade could not be taken. */
function simulate(day: Day, i: number, level: number, rawStop: number, setup: string, mode: Trade['mode']): { trade: Trade; exitIdx: number } | null {
  const { bars, minutes } = day;
  const b = bars[i];
  const entry = Math.max(level, b[1]) + halfSpread(day, minutes[i], level);
  const stop = Math.max(rawStop, entry - STOP_CAP);
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  const shares = Math.floor(Math.min(RISK_USD / risk, LIQUIDITY_CAP * b[5]));
  if (shares < MIN_SHARES) return null;
  const target = entry + TARGET_R * risk;

  let remaining = 1, realized = 0, stopNow = stop, halfTaken = false, ambiguous = false;
  let exit = 'time', j = i + 1;
  for (; j < bars.length && minutes[j] < WINDOW.end; j++) {
    const x = bars[j];
    if (x[3] <= stopNow) {
      if (x[2] > target && !halfTaken) ambiguous = true;                 // both in one bar: the stop is taken
      const fill = Math.min(stopNow, x[1]) - halfSpread(day, minutes[j], stopNow);
      realized += remaining * (fill - entry); remaining = 0; exit = halfTaken ? 'breakeven' : 'stop'; break;
    }
    if (!halfTaken && x[2] > target) {
      if (mode === 'all out at 2R') { realized += target - entry; remaining = 0; exit = 'target'; break; }
      realized += 0.5 * (target - entry); remaining = 0.5; halfTaken = true; stopNow = entry; continue;
    }
    if (halfTaken && (x[4] < x[1] || day.hist[j] < 0)) {
      const fill = x[4] - halfSpread(day, minutes[j], x[4]);
      realized += remaining * (fill - entry); remaining = 0; exit = x[4] < x[1] ? 'red candle' : 'macd'; break;
    }
  }
  if (remaining > 0) {
    const last = bars[Math.min(j, bars.length - 1)];
    const fill = last[4] - halfSpread(day, minutes[Math.min(j, bars.length - 1)], last[4]);
    realized += remaining * (fill - entry);
    j = Math.min(j, bars.length - 1);
  }
  const commission = 2 * COMMISSION_PER_SHARE * shares;
  const pnlUsd = realized * shares - commission;
  const riskUsd = risk * shares;
  return {
    exitIdx: j,
    trade: {
      date: day.date, symbol: day.symbol, setup, mode, entryMinute: minutes[i], exitMinute: minutes[j],
      entry: +entry.toFixed(4), stop: +stop.toFixed(4), shares,
      rGross: (realized * shares + 2 * halfSpread(day, minutes[i], level) * shares) / riskUsd,   // as if the spread were free
      rNet: pnlUsd / riskUsd, pnlUsd: +pnlUsd.toFixed(2), exit, ambiguous,
    },
  };
}

/** Gap and Go: one trade, 09:30–10:00, on a 4%+ gap. */
function gapAndGo(day: Day, variant: 'first candle high' | 'pre-market high', mode: Trade['mode']): Trade[] {
  const { bars, minutes, prevClose } = day;
  const first = minutes.findIndex((m) => m >= GAP_AND_GO.start);
  if (first < 0 || minutes[first] !== GAP_AND_GO.start) return [];
  const pre = bars.filter((_, k) => minutes[k] >= 240 && minutes[k] < GAP_AND_GO.start);
  if (!pre.length) return [];
  const gapPct = (pre[pre.length - 1][4] / prevClose - 1) * 100;
  if (gapPct < MIN_GAP_PCT) return [];
  const trigger = variant === 'first candle high' ? bars[first][2] : Math.max(...pre.map((b) => b[2]));
  const from = variant === 'first candle high' ? first + 1 : first;
  for (let i = from; i < bars.length && minutes[i] < GAP_AND_GO.end; i++) {
    if (bars[i][2] <= trigger) continue;
    const rawStop = variant === 'first candle high' ? bars[first][3] : bars[i - 1][3];
    const r = simulate(day, i, trigger, rawStop, `gap and go: ${variant}`, mode);
    return r ? [r.trade] : [];
  }
  return [];
}

/** First pullback / bull flag, 07:00–11:00, up to MAX_TRADES_PER_DAY entries. */
function pullbacks(day: Day, mode: Trade['mode']): Trade[] {
  const { bars, minutes } = day;
  const trades: Trade[] = [];
  let greens = 0, poleLow = Infinity, poleHigh = 0, flagBars = 0, flagLow = Infinity, trigger = 0, phase: 'scan' | 'flag' = 'scan';
  const reset = () => { greens = 0; poleLow = Infinity; poleHigh = 0; flagBars = 0; flagLow = Infinity; trigger = 0; phase = 'scan'; };
  for (let i = 1; i < bars.length && minutes[i] < WINDOW.end; i++) {
    const b = bars[i], green = b[4] > b[1];
    if (phase === 'flag') {
      if (b[2] > trigger) {
        if (minutes[i] >= Math.max(WINDOW.start, day.inPlay)) {
          const r = simulate(day, i, trigger, flagLow, 'first pullback', mode);
          if (r) { trades.push(r.trade); reset(); i = r.exitIdx; if (trades.length >= MAX_TRADES_PER_DAY) break; continue; }
        }
        reset();
        // The break itself may start a new pole.
        greens = green ? 1 : 0; poleLow = green ? b[3] : Infinity; poleHigh = green ? b[2] : 0;
        continue;
      }
      flagBars++; flagLow = Math.min(flagLow, b[3]); trigger = b[2];
      if (flagBars > MAX_FLAG_BARS || flagLow <= poleLow + 0.5 * (poleHigh - poleLow)) reset();
      continue;
    }
    if (green) { greens++; poleLow = Math.min(poleLow, b[3]); poleHigh = Math.max(poleHigh, b[2]); continue; }
    if (greens >= POLE.minBars && (poleHigh / poleLow - 1) * 100 >= POLE.minPct) {
      phase = 'flag'; flagBars = 1; flagLow = b[3]; trigger = b[2];
    } else reset();
  }
  return trades;
}

function summarize(trades: Trade[]) {
  const r = trades.map((t) => t.rNet);
  const gains = r.filter((x) => x > 0).reduce((a, b) => a + b, 0), losses = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const byDate = new Map<string, number[]>();
  for (const t of trades) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t.rNet);
  const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
  for (let i = 0; i < 2000; i++) { let s = 0, c = 0; for (let j = 0; j < days.length; j++) for (const x of days[Math.floor(rnd() * days.length)]) { s += x; c++; } means.push(s / c); }
  means.sort((a, b) => a - b);
  const byYear: Record<string, number> = {};
  for (const y of [...new Set(trades.map((t) => t.date.slice(0, 4)))].sort()) byYear[y] = mean(trades.filter((t) => t.date.startsWith(y)).map((t) => t.rNet));
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  return {
    trades: r.length, days: byDate.size, winRate: r.filter((x) => x > 0).length / r.length,
    meanR: mean(r), meanRGross: mean(trades.map((t) => t.rGross)), medianR: median(r), meanRCi95: [means[50], means[1949]],
    profitFactor: losses ? gains / losses : null, totalR: r.reduce((a, b) => a + b, 0), pnlUsd: trades.reduce((a, t) => a + t.pnlUsd, 0),
    meanHoldMin: mean(trades.map((t) => t.exitMinute - t.entryMinute)), ambiguous: trades.filter((t) => t.ambiguous).length / r.length,
    exits, byYear,
  };
}

async function main() {
  const sample = (JSON.parse(await readFile('data/early-flags.json', 'utf8')).trades as any[])
    .filter((t) => t.flag === 'first minute it qualifies')
    .map((t) => ({ date: t.date as string, symbol: t.symbol as string, inPlay: t.flagMinute as number }));
  const byDate = new Map<string, { symbol: string; inPlay: number }[]>();
  for (const s of sample) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
  console.log(`${sample.length} stock-days over ${byDate.size} sessions`);

  const dailyCache = new Map<string, Daily[]>();
  const prevCloseOf = async (symbol: string, date: string) => {
    if (!dailyCache.has(symbol)) dailyCache.set(symbol, await readJson<Daily[]>(`data/db/daily/${symbol}.json`, []));
    const d = dailyCache.get(symbol)!, i = d.findIndex((b) => b.date === date);
    return i > 0 ? d[i - 1].close : NaN;
  };

  await mkdir(GAP, { recursive: true });
  let spend = 0;
  const trades: Trade[] = [];
  const dates = [...byDate.keys()].sort();
  let next = 0, done = 0;

  const runDate = async (date: string) => {
    const off = nyOffsetMin(date);
    const full: Record<string, Bar[]> = {};
    for (const dir of FULL_DAY) Object.assign(full, await readJson<Record<string, Bar[]>>(`${dir}/${date}.json`, {}));
    const pre = await readJson<Record<string, Bar[]>>(`${PRE}/${date}.json`, {});
    const reg = await readJson<Record<string, Bar[]>>(`${REG}/${date}.json`, {});
    const quotes = await readJson<Record<string, Quote[]>>(`${QUOTES}/${date}.json`, {});

    // The 08:46–09:29 gap for names without a full day.
    const gapPath = `${GAP}/${date}.json`;
    const gap = await readJson<Record<string, Bar[]>>(gapPath, {});
    const need = byDate.get(date)!.map((s) => s.symbol).filter((s) => !full[s] && !(s in gap));
    if (need.length) {
      const start = new Date(nyMs(date, 526)).toISOString(), end = new Date(nyMs(date, 570)).toISOString();
      for (const b of batches(need)) {
        spend += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'ohlcv-1m', start, end });
        if (DRY) continue;
        for (const s of b) gap[s] = [];
        for await (const bar of streamBars({ dataset: MINUTE_DATASET, symbols: b, schema: 'ohlcv-1m', start, end })) {
          (gap[bar.symbol] ??= []).push([bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume]);
        }
      }
      if (!DRY) await writeFile(gapPath, JSON.stringify(gap));
    }
    if (DRY) return;

    for (const { symbol, inPlay } of byDate.get(date)!) {
      const bars = dedupe(full[symbol] ?? [...(pre[symbol] ?? []), ...(gap[symbol] ?? []), ...(reg[symbol] ?? [])]);
      if (bars.length < 30) continue;
      const prevClose = await prevCloseOf(symbol, date);
      if (!(prevClose > 0)) continue;
      const day: Day = { date, symbol, bars, minutes: bars.map((b) => nyMinute(b[0], off)), hist: macdHistogram(bars.map((b) => b[4])), qs: quotes[symbol], prevClose, inPlay, off };
      for (const mode of ['all out at 2R', 'half at 2R, trail'] as const) {
        trades.push(...gapAndGo(day, 'first candle high', mode), ...gapAndGo(day, 'pre-market high', mode), ...pullbacks(day, mode));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < dates.length) {
      await runDate(dates[next++]);
      if (++done % 50 === 0) console.log(`  ${done}/${dates.length} sessions, ${trades.length} trades, $${spend.toFixed(2)}`);
    }
  }));
  if (DRY) { console.log(`Gap bars to buy: $${spend.toFixed(2)}. --dry: stopping.`); return; }
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.entryMinute - b.entryMinute);

  const setups = [...new Set(trades.map((t) => t.setup))];
  const modes = ['all out at 2R', 'half at 2R, trail'] as const;
  const results: any[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const R = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`;
  console.log(`\n${'setup · exit rule'.padEnd(44)}${'trades'.padStart(7)}${'won'.padStart(6)}${'mean R'.padStart(8)}${'gross'.padStart(7)}${'median'.padStart(8)}  ${'95% range of mean'.padEnd(17)}${'PF'.padStart(5)}${'$ at $500 risk'.padStart(15)}${'hold'.padStart(6)}${'both'.padStart(6)}`);
  for (const setup of setups) for (const mode of modes) {
    const ts = trades.filter((t) => t.setup === setup && t.mode === mode);
    if (!ts.length) continue;
    const s = summarize(ts);
    results.push({ setup, mode, ...s });
    console.log(`${`${setup} · ${mode}`.padEnd(44)}${String(s.trades).padStart(7)}${pct(s.winRate).padStart(6)}${R(s.meanR).padStart(8)}${R(s.meanRGross).padStart(7)}${R(s.medianR).padStart(8)}  ${`${R(s.meanRCi95[0])} … ${R(s.meanRCi95[1])}`.padEnd(17)}${(s.profitFactor?.toFixed(2) ?? '—').padStart(5)}${(`$${Math.round(s.pnlUsd).toLocaleString()}`).padStart(15)}${(`${s.meanHoldMin.toFixed(0)}m`).padStart(6)}${pct(s.ambiguous).padStart(6)}`);
  }
  console.log('\nBy year (mean R): ' + results.map((r) => `${r.setup} · ${r.mode}: ${Object.entries(r.byYear).map(([y, v]) => `${y} ${R(v as number)}`).join(', ')}`).join('\n                  '));
  console.log('Exits: ' + results.map((r) => `${r.setup} · ${r.mode}: ${JSON.stringify(r.exits)}`).join('\n       '));
  // Entry time matters to the source ("sweet spot 07:00–09:30"): the pullback setup by window.
  const buckets: [string, number, number][] = [['pre-market 07:00–09:29', 420, 570], ['open 09:30–09:59', 570, 600], ['10:00–10:59', 600, 660]];
  console.log('\nFirst pullback by entry time (all out at 2R):');
  for (const [name, a, b] of buckets) {
    const ts = trades.filter((t) => t.setup === 'first pullback' && t.mode === 'all out at 2R' && t.entryMinute >= a && t.entryMinute < b);
    if (ts.length) { const s = summarize(ts); console.log(`  ${name.padEnd(24)} ${String(s.trades).padStart(6)} trades  won ${pct(s.winRate)}  mean ${R(s.meanR)}  PF ${s.profitFactor?.toFixed(2)}`); }
  }
  console.log(`\nDatabento spend $${spend.toFixed(2)}`);
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rules: { RISK_USD, COMMISSION_PER_SHARE, STOP_CAP, TARGET_R, WINDOW, GAP_AND_GO, MIN_GAP_PCT, POLE, MAX_FLAG_BARS, MAX_TRADES_PER_DAY, LIQUIDITY_CAP, MIN_SHARES, MAX_SPREAD, FALLBACK_HALF_SPREAD }, sample: { stockDays: sample.length, sessions: byDate.size }, spend: +spend.toFixed(2), results, trades }));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
