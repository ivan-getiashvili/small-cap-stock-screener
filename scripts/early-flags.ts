/**
 * Does spotting a gapper earlier in pre-market capture more of its move? -> data/early-flags.json
 *
 * Run:  node --experimental-strip-types scripts/early-flags.ts [--from=2024-08-01] [--to=2026-09-11]
 * Needs DATABENTO_KEY and the local daily bar cache (data/db/daily). About $13 for two years.
 *
 * Ivan's question (2026-09-14): "if the big move happens before 08:45, why not
 * identify those opportunities at 04:00 or 07:00, buy pre-market and close
 * 15 minutes after the bell?" So each stock is flagged at several moments —
 * 06:00, 07:00, 08:00, 08:45 ET, and the FIRST minute it ever qualifies — with
 * the same gate every time (up 10%+ on the previous close, 50k+ shares traded so
 * far, $2–$20), bought at that moment's ask, and sold at the open, 09:45, 10:00
 * and the close.
 *
 * Honesty rules:
 * 1. EVERY small cap priced $1–$25 at the previous close is replayed from its
 *    own pre-market bars, no preselection. A daily-bar preselection was tried and
 *    validated against 20 all-symbol sessions: it lost 16 of 273 early qualifiers,
 *    all stocks that spiked pre-market and collapsed before the bell — exactly
 *    the trades an early buyer takes — and no daily-bar rule short of "everything"
 *    caught them. Funds and non-common tickers are excluded like the live scan.
 * 2. Buys pay the ask, timed sells take the bid (Nasdaq best quote, sampled
 *    each minute); a quote wider than MAX_SPREAD or away from the last price is
 *    unusable and FALLBACK_HALF_SPREAD is paid. Auction and close fills are prints.
 * 3. No position size. Pre-market books are thin; the half-spread and the shares
 *    traded so far are reported next to each flag time so that is visible.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { streamBars, streamQuotes, getCost, batches, MINUTE_DATASET } from '../lib/sources/databento.ts';

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Minute = [number, number, number, number, number, number];
type Quote = [number, number | null, number | null];

const DAILY = 'data/db/daily';
// Whole-day caches only. data/db/early-bars holds regular-session bars alone and
// must never stand in for pre-market bars: a name found there would replay as
// "no pre-market trades" and silently drop out.
const FULL_DAY = ['data/db/minutes', 'data/db/strategy-bars'];
const ALLSYM = 'data/db/allsym-premarket';
const BARS = 'data/db/early-bars';
const QUOTES = 'data/db/early-quotes';
const OUT = 'data/early-flags.json';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FROM = arg('from') ?? '2024-08-01';
const TO = arg('to') ?? '2026-09-11';
const CONCURRENCY = 6;

const BAND = { min: 1, max: 25 };
const GATE = { minChangePct: 10, minVolume: 50_000, priceMin: 2, priceMax: 20 };
const FLAGS: [string, number][] = [['06:00', 360], ['07:00', 420], ['08:00', 480], ['08:45', 525]];
const FIRST = 'first minute it qualifies';
const EXITS = ['open', '09:45', '10:00', 'close'] as const;
const MAX_SPREAD = 0.2;
const FALLBACK_HALF_SPREAD = 0.01;

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
const nyMinute = (ts: number, off: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
const isNonCommon = (s: string) => s.length === 5 && 'PWURQ'.includes(s[4]);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** Sorted by time, one bar per timestamp: Databento returned every bar twice for 2025-06-09. */
function dedupe(bars: Minute[]): Minute[] {
  const out: Minute[] = [];
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

/** Pre-market state after every bar stamped ≤ minute m: last price and shares so far. */
function stateAt(bars: Minute[], off: number, m: number): { last: number; vol: number } {
  let last = 0, vol = 0;
  for (const b of bars) { const bm = nyMinute(b[0], off); if (bm >= 240 && bm <= m) { last = b[4]; vol += b[5]; } }
  return { last, vol };
}
const passes = (s: { last: number; vol: number }, prevClose: number) =>
  s.last >= GATE.priceMin && s.last <= GATE.priceMax && s.vol >= GATE.minVolume && (s.last / prevClose - 1) * 100 >= GATE.minChangePct;

/** The first minute (04:00–08:45) at which the gate holds, or null. */
function firstQualifying(bars: Minute[], off: number, prevClose: number): number | null {
  let last = 0, vol = 0;
  for (const b of bars) {
    const m = nyMinute(b[0], off);
    if (m < 240) continue;
    if (m > 525) break;
    last = b[4]; vol += b[5];
    if (passes({ last, vol }, prevClose)) return m;
  }
  return null;
}

type Trade = {
  date: string; symbol: string; flag: string; flagMinute: number;
  changeAtFlagPct: number; sharesAtFlag: number; halfSpreadPct: number | null;
  toEightFortyFivePct: number | null; ret: Record<string, number>;
};

function summarize(trades: Trade[], exit: string) {
  const rets = trades.map((t) => t.ret[exit]);
  const gains = rets.filter((x) => x > 0).reduce((a, b) => a + b, 0), losses = -rets.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const byDate = new Map<string, number[]>();
  for (const t of trades) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t.ret[exit]);
  // Resample whole mornings: one hot or cold day moves every name on it together.
  const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
  for (let i = 0; i < 2000; i++) { let s = 0, c = 0; for (let j = 0; j < days.length; j++) { for (const x of days[Math.floor(rnd() * days.length)]) { s += x; c++; } } means.push(s / c); }
  means.sort((a, b) => a - b);
  return { trades: rets.length, winRate: rets.filter((x) => x > 0).length / rets.length, median: median(rets), mean: mean(rets), meanCi95: [means[50], means[1949]], profitFactor: losses ? gains / losses : null };
}

async function main() {
  const aapl = await readJson<Daily[]>(`${DAILY}/AAPL.json`, []);
  const prevOf = new Map(aapl.slice(1).map((b, i) => [b.date, aapl[i].date]));
  const sessions = aapl.map((b) => b.date).filter((d) => d >= FROM && d <= TO && prevOf.has(d));
  const sessionSet = new Set(sessions);
  const etfs = new Set(await readJson<string[]>('data/db/etfs.json', []));
  if (!etfs.size) console.warn('No data/db/etfs.json: ETFs are NOT excluded');

  // The whole band, by the previous close — never by what happened next.
  const universe = new Map<string, Map<string, number>>();        // date -> symbol -> prev close
  for (const f of await readdir(DAILY)) {
    const sym = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || isNonCommon(sym) || etfs.has(sym)) continue;
    const bars = await readJson<Daily[]>(`${DAILY}/${f}`, []);
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i], p = bars[i - 1];
      if (!sessionSet.has(d.date) || prevOf.get(d.date) !== p.date) continue;
      if (!(p.close >= BAND.min && p.close <= BAND.max)) continue;
      (universe.get(d.date) ?? universe.set(d.date, new Map()).get(d.date)!).set(sym, p.close);
    }
  }
  const inBand = [...universe.values()].reduce((a, m) => a + m.size, 0);
  console.log(`${sessions.length} sessions ${sessions[0]} → ${sessions.at(-1)}; ${inBand.toLocaleString()} symbol-days in band`);

  let spend = 0;
  const buyBars = async (path: string, symbols: string[], start: string, end: string) => {
    const have = await readJson<Record<string, Minute[]>>(path, {});
    const missing = symbols.filter((s) => !(s in have));
    for (const b of batches(missing)) {
      spend += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'ohlcv-1m', start, end });
      for (const s of b) have[s] = [];
      for await (const bar of streamBars({ dataset: MINUTE_DATASET, symbols: b, schema: 'ohlcv-1m', start, end })) {
        (have[bar.symbol] ??= []).push([bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume]);
      }
    }
    if (missing.length) await writeFile(path, JSON.stringify(have));
    return have;
  };
  for (const dir of [ALLSYM, BARS, QUOTES]) await mkdir(dir, { recursive: true });

  const trades: Trade[] = [];
  let quoteUses = 0, quoteFallbacks = 0;

  const runSession = async (date: string) => {
    const band = universe.get(date);
    if (!band?.size) return;
    const off = nyOffsetMin(date);
    const iso = (m: number) => new Date(nyMs(date, m)).toISOString();
    const full: Record<string, Minute[]> = {};
    for (const dir of FULL_DAY) Object.assign(full, await readJson<Record<string, Minute[]>>(`${dir}/${date}.json`, {}));

    // Pre-market bars for the whole band (names with a full day cached already are skipped).
    const allsym = await buyBars(`${ALLSYM}/${date}.json`, [...band.keys()].filter((s) => !full[s]), iso(240), iso(526));
    const preBars = (s: string) => { const b = full[s] ?? allsym[s]; return b?.length ? dedupe(b) : undefined; };

    type Flagged = { symbol: string; prevClose: number; flag: string; minute: number };
    const flagged: Flagged[] = [];
    for (const [symbol, prevClose] of band) {
      const bars = preBars(symbol);
      if (!bars) continue;
      for (const [name, m] of FLAGS) if (passes(stateAt(bars, off, m), prevClose)) flagged.push({ symbol, prevClose, flag: name, minute: m });
      const fm = firstQualifying(bars, off, prevClose);
      if (fm !== null) flagged.push({ symbol, prevClose, flag: FIRST, minute: fm });
    }
    if (!flagged.length) return;
    const symbols = [...new Set(flagged.map((f) => f.symbol))];

    // Regular-session bars for anything flagged without a full day yet, and quotes for all of it.
    const bought = await buyBars(`${BARS}/${date}.json`, symbols.filter((s) => !full[s]), iso(570), iso(960));
    const quotesPath = `${QUOTES}/${date}.json`;
    const quotes = await readJson<Record<string, Quote[]>>(quotesPath, {});
    const missingQuotes = symbols.filter((s) => !(s in quotes));
    for (const b of batches(missingQuotes)) {
      spend += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'cbbo-1m', start: iso(240), end: iso(960) });
      for (const s of b) quotes[s] = [];
      for await (const q of streamQuotes({ dataset: MINUTE_DATASET, symbols: b, start: iso(240), end: iso(960) })) {
        (quotes[q.symbol] ??= []).push([q.ts, Number.isNaN(q.bid) ? null : q.bid, Number.isNaN(q.ask) ? null : q.ask]);
      }
    }
    if (missingQuotes.length) await writeFile(quotesPath, JSON.stringify(quotes));

    for (const f of flagged) {
      const bars = dedupe([...(preBars(f.symbol) ?? []), ...(full[f.symbol] ? [] : bought[f.symbol] ?? [])]);
      const regular = bars.filter((b) => { const m = nyMinute(b[0], off); return m >= 570 && m < 960; });
      if (!regular.length) continue;
      const qs = quotes[f.symbol];
      const usable = (q: { bid: number; ask: number } | null, ref: number) => {
        quoteUses++;
        if (q && q.ask - q.bid <= MAX_SPREAD * ref && Math.abs((q.ask + q.bid) / 2 / ref - 1) <= MAX_SPREAD) return q;
        quoteFallbacks++; return null;
      };
      const at = stateAt(bars, off, f.minute);
      const buyQuote = usable(quoteAt(qs, nyMs(date, f.minute + 1)), at.last);
      const buy = buyQuote ? buyQuote.ask : at.last * (1 + FALLBACK_HALF_SPREAD);
      const sellAt = (m: number) => {
        const lastBar = regular.filter((b) => nyMinute(b[0], off) < m).at(-1) ?? regular[0];
        const q = usable(quoteAt(qs, nyMs(date, m)), lastBar[4]);
        return q ? q.bid : lastBar[4] * (1 - FALLBACK_HALF_SPREAD);
      };
      const open = regular[0][1], close = regular.at(-1)![4];
      const r = (sell: number) => sell / buy - 1;
      const eightFortyFive = stateAt(bars, off, 525).last;
      trades.push({
        date, symbol: f.symbol, flag: f.flag, flagMinute: f.minute,
        changeAtFlagPct: +((at.last / f.prevClose - 1) * 100).toFixed(1), sharesAtFlag: at.vol,
        halfSpreadPct: buyQuote ? +(((buyQuote.ask - buyQuote.bid) / 2 / at.last) * 100).toFixed(2) : null,
        toEightFortyFivePct: eightFortyFive > 0 ? +((eightFortyFive / at.last - 1) * 100).toFixed(1) : null,
        ret: { open: r(open), '09:45': r(sellAt(585)), '10:00': r(sellAt(600)), close: r(close) },
      });
    }
  };

  let next = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < sessions.length) {
      await runSession(sessions[next++]);
      if (++done % 25 === 0) console.log(`  ${done}/${sessions.length} sessions, ${trades.length} trades, $${spend.toFixed(2)}`);
    }
  }));
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  const pct = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
  const flagNames = [...FLAGS.map(([n]) => n), FIRST];
  const results: any[] = [];
  console.log(`\n${'flagged at'.padEnd(26)}${'names'.padStart(6)}${'/day'.padStart(6)}${'up at flag'.padStart(11)}${'shares'.padStart(9)}${'½spread'.padStart(8)}${'→08:45'.padStart(8)}`);
  for (const flag of flagNames) {
    const ts = trades.filter((t) => t.flag === flag);
    if (!ts.length) continue;
    const spreads = ts.map((t) => t.halfSpreadPct).filter((x): x is number => x != null);
    const cont = ts.map((t) => t.toEightFortyFivePct).filter((x): x is number => x != null);
    const row = { flag, trades: ts.length, perDay: ts.length / new Set(ts.map((t) => t.date)).size, medianChangeAtFlagPct: median(ts.map((t) => t.changeAtFlagPct)), medianSharesAtFlag: median(ts.map((t) => t.sharesAtFlag)), medianHalfSpreadPct: spreads.length ? median(spreads) : null, medianToEightFortyFivePct: cont.length ? median(cont) : null, flagMinuteQuartiles: flag === FIRST ? [0.25, 0.5, 0.75].map((p) => hhmm([...ts].map((t) => t.flagMinute).sort((a, b) => a - b)[Math.floor(p * (ts.length - 1))])) : null, exits: Object.fromEntries(EXITS.map((e) => [e, summarize(ts, e)])) };
    results.push(row);
    console.log(`${flag.padEnd(26)}${String(row.trades).padStart(6)}${row.perDay.toFixed(1).padStart(6)}${(`+${row.medianChangeAtFlagPct.toFixed(0)}%`).padStart(11)}${Math.round(row.medianSharesAtFlag).toLocaleString().padStart(9)}${(row.medianHalfSpreadPct == null ? '—' : row.medianHalfSpreadPct.toFixed(2) + '%').padStart(8)}${(row.medianToEightFortyFivePct == null ? '—' : `${row.medianToEightFortyFivePct >= 0 ? '+' : ''}${row.medianToEightFortyFivePct.toFixed(1)}%`).padStart(8)}${row.flagMinuteQuartiles ? `   first-minute quartiles ${row.flagMinuteQuartiles.join(' / ')}` : ''}`);
  }
  console.log(`\n${'flagged at → sold at'.padEnd(36)}${'won'.padStart(6)}${'median'.padStart(9)}${'mean'.padStart(8)}  ${'95% range of mean'.padEnd(19)}${'PF'.padStart(5)}`);
  for (const row of results) for (const e of EXITS) {
    const s = row.exits[e];
    console.log(`${`${row.flag} → ${e}`.padEnd(36)}${pct(s.winRate).padStart(6)}${pct(s.median).padStart(9)}${pct(s.mean).padStart(8)}  ${`${pct(s.meanCi95[0])} … ${pct(s.meanCi95[1])}`.padEnd(19)}${(s.profitFactor?.toFixed(2) ?? '—').padStart(5)}`);
  }
  console.log(`\nquote fallbacks ${(100 * quoteFallbacks / Math.max(1, quoteUses)).toFixed(1)}% · Databento spend $${spend.toFixed(2)}`);
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, to: TO, rules: { BAND, GATE, FLAGS, EXITS, MAX_SPREAD, FALLBACK_HALF_SPREAD }, spend: +spend.toFixed(2), results, trades }));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
