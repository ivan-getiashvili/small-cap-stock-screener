/**
 * Compare simple ways to trade the stocks the 08:45 scan flags -> data/strategies.json
 *
 * Run:  node --experimental-strip-types scripts/session-strategies.ts --dry
 *       node --experimental-strip-types scripts/session-strategies.ts [--from=2024-08-01] [--to=2026-09-11]
 * Needs DATABENTO_KEY and the local daily bar cache (data/db/daily).
 *
 * Compared on every flagged stock:
 *   pre-market → open     buy at the 08:45 ET ask, sell in the opening auction
 *   pre-market → close    buy at the 08:45 ET ask, sell at the close
 *   open → noon           buy in the opening auction, sell at the 12:00 bid
 *   open → close          buy in the opening auction, sell at the close
 *   open, X% trailing     buy in the opening auction, sell once price falls X% below
 *                         its highest point since the buy (else at the close)
 *
 * The rules that keep the answer honest:
 * 1. The sample is what the scan would have flagged at 08:45 — up 10%+ on the
 *    previous close, 50k+ shares traded, priced $2–$20 — measured on 1-minute
 *    bars, never on how the day turned out.
 * 2. Bars are bought in two steps: pre-market (04:00–08:45) for candidates, then
 *    the whole day only for the stocks that got flagged. Pre-market bars for all
 *    ~4,600 small caps cost ~$0.018 a session, so candidates are preselected from
 *    daily bars: opened up, traded 10% up, or traded unusually heavy volume. The
 *    volume path is there for stocks that spike pre-market and collapse before the
 *    bell, which never show in a regular-session open or high. The preselection
 *    looks at the day itself, so it is checked: on the mornings the all-symbol
 *    replay covered (data/history.json, source "replay"), it must keep every name
 *    that replay flagged, or the run stops.
 * 3. Fills pay the spread. The pre-market buy pays the ask; the noon and stop
 *    sells take the bid, from Nasdaq's best quote sampled each minute. A quote
 *    wider than MAX_SPREAD, or away from the last price, is treated as unusable
 *    and FALLBACK_HALF_SPREAD is paid instead. Auction fills are at the print.
 * 4. The stop is checked from the opening bar on, against the highest price up
 *    to the previous minute. Order inside a minute is unknown.
 * 5. No position size is modelled. Thin pre-market books cap what could
 *    really be bought, so the pre-market rows are an upper bound on size.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { streamBars, streamQuotes, getCost, batches, MINUTE_DATASET } from '../lib/sources/databento.ts';

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Minute = [number, number, number, number, number, number];   // ts ms, open, high, low, close, volume
type Quote = [number, number | null, number | null];               // ts ms, bid, ask (null: no quote)

const DAILY = 'data/db/daily';
const CACHED = 'data/db/minutes';              // full-day bars bought earlier for the intraday backtest
const PREMARKET = 'data/db/strategy-premarket';
const BARS = 'data/db/strategy-bars';
const QUOTES = 'data/db/strategy-quotes';
const OUT = 'data/strategies.json';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const DRY = process.argv.includes('--dry');
const FROM = arg('from') ?? '2024-08-01';
const TO = arg('to') ?? '2026-09-11';
/** Sessions fetched at once. One at a time took ~25s a session. */
const CONCURRENCY = 6;

const BAND = { min: 1, max: 25 };
const GATE = { minChangePct: 10, minVolume: 50_000, priceMin: 2, priceMax: 20 };
const PRESELECT = { minOpenGapPct: 2, minHighPct: 10, minVolumeMultiple: 3, volumeDays: 20 };
const TRAILS = [5, 10, 20];
/** A quote this wide (fraction of price) is not one anybody would trade through. */
const MAX_SPREAD = 0.2;
/** Half-spread paid when no usable quote exists, as a fraction of price. */
const FALLBACK_HALF_SPREAD = 0.01;

/** Minutes to add to New York wall-clock time to get UTC, on this date. */
function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, hh: number, mm: number) => Date.parse(`${date}T00:00:00Z`) + (hh * 60 + mm + nyOffsetMin(date)) * 60_000;
const nyMinute = (ts: number, off: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
const isNonCommon = (s: string) => s.length === 5 && 'PWURQ'.includes(s[4]);

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** The latest quote at or before t, if it is recent and two-sided. */
function quoteAt(qs: Quote[] | undefined, t: number): { bid: number; ask: number } | null {
  if (!qs?.length) return null;
  let lo = 0, hi = qs.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (qs[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0 || t - qs[k][0] > 30 * 60_000) return null;
  const [, bid, ask] = qs[k];
  return bid != null && ask != null && bid > 0 && ask >= bid ? { bid, ask } : null;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type Trade = { date: string; symbol: string; changePct: number; preHalfSpreadPct: number | null; ret: Record<string, number> };

function summarize(name: string, trades: Trade[]) {
  const rets = trades.map((t) => t.ret[name]);
  const gains = rets.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -rets.filter((x) => x < 0).reduce((a, b) => a + b, 0);

  const byDate = new Map<string, number[]>();
  for (const t of trades) (byDate.get(t.date) ?? byDate.set(t.date, []).get(t.date)!).push(t.ret[name]);

  // One hot or cold morning moves every name on it together, so the
  // uncertainty comes from resampling whole mornings, not single trades.
  const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let s = 0, c = 0;
    for (let j = 0; j < days.length; j++) { const d = days[Math.floor(rnd() * days.length)]; for (const x of d) { s += x; c++; } }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);

  // Whole account in every morning, split evenly across that morning's names.
  let equity = 1, top = 1, maxDrawdown = 0;
  for (const d of [...byDate.keys()].sort()) {
    equity *= 1 + mean(byDate.get(d)!);
    top = Math.max(top, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / top);
  }

  const byYear: Record<string, { trades: number; mean: number; median: number }> = {};
  for (const y of [...new Set(trades.map((t) => t.date.slice(0, 4)))].sort()) {
    const r = trades.filter((t) => t.date.startsWith(y)).map((t) => t.ret[name]);
    byYear[y] = { trades: r.length, mean: mean(r), median: median(r) };
  }

  return {
    name, trades: rets.length, winRate: rets.filter((x) => x > 0).length / rets.length,
    mean: mean(rets), meanCi95: [means[50], means[1949]], median: median(rets),
    profitFactor: losses ? gains / losses : null,
    worst: Math.min(...rets), best: Math.max(...rets),
    compounded: equity - 1, maxDrawdown, byYear,
  };
}

async function main() {
  // 1. Sessions, and daily-bar candidates in one pass over the cache.
  const aapl = await readJson<Daily[]>(`${DAILY}/AAPL.json`, []);
  const prevOf = new Map(aapl.slice(1).map((b, i) => [b.date, aapl[i].date]));
  const sessions = aapl.map((b) => b.date).filter((d) => d >= FROM && d <= TO && prevOf.has(d));
  const sessionSet = new Set(sessions);
  // Funds are not companies, and the live scan's stock screener leaves them out.
  // Nasdaq's symbol directory knows only current listings, so a fund that has
  // since closed can still slip through.
  const etfs = new Set(await readJson<string[]>('data/db/etfs.json', []));
  if (!etfs.size) console.warn('No data/db/etfs.json: ETFs are NOT excluded');
  const candidates = new Map<string, Map<string, number>>();   // date -> symbol -> previous close
  for (const f of await readdir(DAILY)) {
    const sym = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || isNonCommon(sym) || etfs.has(sym)) continue;
    const bars = await readJson<Daily[]>(`${DAILY}/${f}`, []);
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i], p = bars[i - 1];
      if (!sessionSet.has(d.date) || prevOf.get(d.date) !== p.date) continue;
      if (!(p.close >= BAND.min && p.close <= BAND.max)) continue;
      const gap = (d.open / p.close - 1) * 100, high = (d.high / p.close - 1) * 100;
      const window = bars.slice(Math.max(0, i - PRESELECT.volumeDays), i);
      const avgVolume = window.reduce((a, b) => a + b.volume, 0) / window.length;
      const heavy = avgVolume > 0 && d.volume >= PRESELECT.minVolumeMultiple * avgVolume;
      if (gap < PRESELECT.minOpenGapPct && high < PRESELECT.minHighPct && !heavy) continue;
      (candidates.get(d.date) ?? candidates.set(d.date, new Map()).get(d.date)!).set(sym, p.close);
    }
  }
  const preselected = [...candidates.values()].reduce((a, m) => a + m.size, 0);
  console.log(`${sessions.length} sessions ${sessions[0]} → ${sessions.at(-1)}; ${preselected.toLocaleString()} preselected symbol-days`);

  // 2. The preselection saw the day, so prove it drops nothing the gate would take.
  const history = await readJson<any>('data/history.json', { days: {} });
  const replayed: { date: string; symbol: string }[] = [];
  for (const [date, day] of Object.entries<any>(history.days)) {
    if (day.source !== 'replay' || !sessionSet.has(date)) continue;
    for (const n of day.names) {
      if (n.preMarketChangePct >= GATE.minChangePct && n.preMarketVolume >= GATE.minVolume
        && n.preMarketPrice >= GATE.priceMin && n.preMarketPrice <= GATE.priceMax) replayed.push({ date, symbol: n.symbol });
    }
  }
  const lost = replayed.filter((r) => !candidates.get(r.date)?.has(r.symbol));
  console.log(`Preselection keeps ${replayed.length - lost.length}/${replayed.length} names the all-symbol replay flagged`);
  if (lost.length) {
    console.error(`  lost: ${lost.map((r) => `${r.date} ${r.symbol}`).join(', ')}\nWiden PRESELECT before trusting any result.`);
    process.exit(1);
  }

  // 3. Buy what is missing, flag at 08:45, and trade each flagged stock every way.
  for (const dir of [PREMARKET, BARS, QUOTES]) await mkdir(dir, { recursive: true });
  let spend = 0, flaggedDays = 0, noRegularSession = 0, quoteFallbacks = 0, quoteUses = 0;
  const trades: Trade[] = [];

  const runSession = async (date: string) => {
    const cands = candidates.get(date);
    if (!cands?.size) return;
    const off = nyOffsetMin(date);
    const iso = (hh: number, mm: number) => new Date(nyMs(date, hh, mm)).toISOString();
    const cached = await readJson<Record<string, Minute[]>>(`${CACHED}/${date}.json`, {});

    /**
     * Minute bars for these symbols, bought once and kept in `path`. Every
     * symbol asked for is recorded, even one that never traded, so a re-run
     * never pays for the same empty answer twice.
     */
    const buyBars = async (path: string, symbols: string[], start: string, end: string) => {
      const have = await readJson<Record<string, Minute[]>>(path, {});
      const missing = symbols.filter((s) => !(s in have));
      if (!missing.length) return have;
      for (const b of batches(missing)) {
        spend += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'ohlcv-1m', start, end });
        if (DRY) continue;
        for (const s of b) have[s] = [];
        for await (const bar of streamBars({ dataset: MINUTE_DATASET, symbols: b, schema: 'ohlcv-1m', start, end })) {
          (have[bar.symbol] ??= []).push([bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume]);
        }
      }
      if (!DRY) await writeFile(path, JSON.stringify(have));
      return have;
    };

    // Step 1: pre-market bars for every candidate the earlier pull did not cover.
    const pre = await buyBars(`${PREMARKET}/${date}.json`, [...cands.keys()].filter((s) => !cached[s]), iso(4, 0), iso(8, 46));
    if (DRY) return;

    const flagged: { symbol: string; prevClose: number; last: number; bars: Minute[] }[] = [];
    for (const [symbol, prevClose] of cands) {
      const bars = cached[symbol] ?? pre[symbol];
      if (!bars?.length) continue;
      let last = 0, volume = 0;
      for (const b of bars) {
        const m = nyMinute(b[0], off);
        if (m >= 240 && m < 526) { last = b[4]; volume += b[5]; }        // 04:00–08:45 ET
      }
      const change = (last / prevClose - 1) * 100;
      if (last >= GATE.priceMin && last <= GATE.priceMax && change >= GATE.minChangePct && volume >= GATE.minVolume) {
        flagged.push({ symbol, prevClose, last, bars });
      }
    }
    if (!flagged.length) return;
    flaggedDays++;

    // Step 2: the whole day and the quotes, only for flagged stocks.
    const full = await buyBars(`${BARS}/${date}.json`, flagged.filter((f) => !cached[f.symbol]).map((f) => f.symbol), iso(4, 0), iso(16, 0));
    for (const f of flagged) f.bars = cached[f.symbol] ?? full[f.symbol] ?? [];

    const quotesPath = `${QUOTES}/${date}.json`;
    const quotes = await readJson<Record<string, Quote[]>>(quotesPath, {});
    const missingQuotes = flagged.map((f) => f.symbol).filter((s) => !(s in quotes));
    if (missingQuotes.length) {
      for (const b of batches(missingQuotes)) {
        spend += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'cbbo-1m', start: iso(8, 30), end: iso(16, 0) });
        for (const s of b) quotes[s] = [];
        for await (const q of streamQuotes({ dataset: MINUTE_DATASET, symbols: b, start: iso(8, 30), end: iso(16, 0) })) {
          (quotes[q.symbol] ??= []).push([q.ts, Number.isNaN(q.bid) ? null : q.bid, Number.isNaN(q.ask) ? null : q.ask]);
        }
      }
      await writeFile(quotesPath, JSON.stringify(quotes));
    }

    for (const f of flagged) {
      const regular = f.bars.filter((b) => { const m = nyMinute(b[0], off); return m >= 570 && m < 960; });
      if (!regular.length) { noRegularSession++; continue; }
      const qs = quotes[f.symbol];
      const usable = (q: { bid: number; ask: number } | null, ref: number) => {
        quoteUses++;
        if (q && q.ask - q.bid <= MAX_SPREAD * ref && Math.abs((q.ask + q.bid) / 2 / ref - 1) <= MAX_SPREAD) return q;
        quoteFallbacks++;
        return null;
      };

      const open = regular[0][1], close = regular.at(-1)![4];
      const preQuote = usable(quoteAt(qs, nyMs(date, 8, 46)), f.last);
      const preBuy = preQuote ? preQuote.ask : f.last * (1 + FALLBACK_HALF_SPREAD);
      const beforeNoon = regular.filter((b) => nyMinute(b[0], off) < 720).at(-1) ?? regular[0];
      const noonQuote = usable(quoteAt(qs, nyMs(date, 12, 0)), beforeNoon[4]);
      const noonSell = noonQuote ? noonQuote.bid : beforeNoon[4] * (1 - FALLBACK_HALF_SPREAD);

      const trail = (pct: number) => {
        let peak = open;
        for (const b of regular) {
          const stop = peak * (1 - pct / 100);
          if (b[3] <= stop) {
            const level = Math.min(stop, b[1]);                           // a gap through the stop fills at the open
            const q = usable(quoteAt(qs, b[0] + 60_000), level);
            return q ? level - (q.ask - q.bid) / 2 : level * (1 - FALLBACK_HALF_SPREAD);
          }
          peak = Math.max(peak, b[2]);
        }
        return close;
      };

      const r = (buy: number, sell: number) => sell / buy - 1;
      trades.push({
        date, symbol: f.symbol,
        changePct: +((f.last / f.prevClose - 1) * 100).toFixed(1),
        preHalfSpreadPct: preQuote ? +(((preQuote.ask - preQuote.bid) / 2 / f.last) * 100).toFixed(2) : null,
        ret: {
          'pre-market → open': r(preBuy, open),
          'pre-market → close': r(preBuy, close),
          'open → noon': r(open, noonSell),
          'open → close': r(open, close),
          ...Object.fromEntries(TRAILS.map((x) => [`open, ${x}% trailing stop`, r(open, trail(x))])),
        },
      });
    }
  };

  // Sessions are independent of each other, so several are fetched at once.
  let next = 0, done = 0;
  const worker = async () => {
    while (next < sessions.length) {
      await runSession(sessions[next++]);
      if (++done % 25 === 0) console.log(`  ${done}/${sessions.length} sessions, ${trades.length} flagged stock-days, $${spend.toFixed(2)}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  if (DRY) {
    console.log(`\nPre-market bars to buy: $${spend.toFixed(2)}. Whole-day bars and quotes are then bought only for flagged stocks.`);
    console.log('--dry: stopping before any billable pull.');
    return;
  }

  const refound = replayed.filter((r) => trades.some((t) => t.date === r.date && t.symbol === r.symbol)).length;
  const spreads = trades.map((t) => t.preHalfSpreadPct).filter((x): x is number => x != null);
  const sample = {
    sessions: sessions.length, sessionsWithFlags: flaggedDays, flaggedStockDays: trades.length,
    noRegularSession, replayNamesRefound: `${refound}/${replayed.length}`,
    medianPreMarketHalfSpreadPct: spreads.length ? median(spreads) : null,
    quoteFallbackRate: quoteUses ? quoteFallbacks / quoteUses : null,
    databentoSpend: +spend.toFixed(2),
  };
  const names = Object.keys(trades[0]?.ret ?? {});
  const strategies = names.map((n) => summarize(n, trades));

  const pct = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
  console.log('\n', sample);
  console.log(`\n${'strategy'.padEnd(26)}${'trades'.padStart(7)}${'won'.padStart(7)}${'median'.padStart(9)}${'mean'.padStart(8)}  ${'95% range of mean'.padEnd(19)}${'PF'.padStart(5)}${'compounded'.padStart(13)}${'max DD'.padStart(8)}`);
  for (const s of strategies) {
    console.log(`${s.name.padEnd(26)}${String(s.trades).padStart(7)}${pct(s.winRate).padStart(7)}${pct(s.median).padStart(9)}${pct(s.mean).padStart(8)}  ${`${pct(s.meanCi95[0])} … ${pct(s.meanCi95[1])}`.padEnd(19)}${(s.profitFactor?.toFixed(2) ?? '—').padStart(5)}${pct(s.compounded).padStart(13)}${pct(-s.maxDrawdown).padStart(8)}`);
  }
  console.log('\nBy year (mean / median per trade):');
  for (const s of strategies) {
    console.log(`  ${s.name.padEnd(26)}${Object.entries(s.byYear).map(([y, v]) => `${y} ${pct(v.mean)} / ${pct(v.median)} (${v.trades})`).join('   ')}`);
  }

  await writeFile(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), from: FROM, to: TO,
    rules: { BAND, GATE, PRESELECT, TRAILS, MAX_SPREAD, FALLBACK_HALF_SPREAD },
    sample, strategies, trades,
  }));
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
