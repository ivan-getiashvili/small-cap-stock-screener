/**
 * Scan the whole US market and produce today's shortlist -> data/screen.json
 *
 * Run:  npm run ingest
 *
 * Shape of the work:
 *   1. One request gets every listed stock with price, % change and volume.
 *   2. A cheap pre-filter cuts ~6,000 names to a few dozen worth investigating.
 *   3. Only those few get the expensive per-symbol calls (history, float, news).
 *
 * That ordering is the whole reason this can run every few minutes for free.
 * Reversing it — fetching history for 6,000 symbols — would take hours.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { getUniverse, getBars } from '../lib/sources/nasdaq.ts';
import { getTickerToCik, getFloat, makePriceLookup, floatFromSharesOutstanding } from '../lib/sources/sec.ts';
import { findCatalyst } from '../lib/sources/news.ts';
import { gapFilter, qualityScore, relativeVolume, bestSpike, dayOfRun, CRITERIA } from '../lib/screen.ts';
import type { Candidate, Quote, Float } from '../lib/types.ts';

/** Wide enough to show near-misses, tight enough to keep the scan cheap. */
const PREFILTER = { priceMin: 1, priceMax: 25, minChangePct: 5, minVolume: 200_000 };
const CONCURRENCY = 4;

/** Minutes since 09:30 America/New_York, or null when the market is shut. */
function minutesFromOpen(now = new Date()): number | null {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return null;
  const mins = et.getHours() * 60 + et.getMinutes();
  const open = 9 * 60 + 30, close = 16 * 60, preOpen = 4 * 60;
  if (mins < preOpen || mins > close) return null;
  return mins - open;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Float, with a plausibility gate.
 *
 * EDGAR reports public float in DOLLARS on a fiscal year-end. Converting to
 * shares needs the price on that date, and small caps reverse-split constantly,
 * which can make that conversion wrong by an order of magnitude. So an SEC
 * figure is only trusted when it lands between 1% and 100% of shares
 * outstanding; otherwise we fall back to the proxy and say so in the UI.
 */
function reconcileFloat(
  sec: Float | null,
  sharesOutstanding: number | null,
  asOf: string,
  todayVolume: number,
): Float | null {
  if (sec && sharesOutstanding) {
    const ratio = sec.floatShares / sharesOutstanding;
    // Two independent sanity checks, both learned from real bad output:
    //  - Exchanges require a meaningful public float, so anything under 5% of
    //    shares outstanding is far more likely a split artefact than a fact.
    //  - No real stock turns over its float 50 times in a session. When the
    //    implied rotation says otherwise, the float is wrong, not the volume.
    const impliedRotation = todayVolume / sec.floatShares;
    if (ratio >= 0.05 && ratio <= 1.0 && impliedRotation <= 50) return sec;
  } else if (sec && !sharesOutstanding && todayVolume / sec.floatShares <= 50) {
    return sec;
  }
  // The proxy can be stale too: Nasdaq's market cap lags reverse splits and
  // dilution, which small caps do constantly. If it implies an impossible
  // rotation, report the float as unknown rather than publish a wrong one.
  const proxy = floatFromSharesOutstanding(sharesOutstanding, asOf);
  if (proxy && todayVolume / proxy.floatShares > 50) return null;
  return proxy;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log('Scanning the US market…');

  const { quotes: universe, asOf: reportedAsOf } = await getUniverse();
  console.log(`  universe: ${universe.length} listed stocks, priced as of ${reportedAsOf ?? 'date not stated'}`);

  // Market environment — the scoring source's seventh indicator, measured across everything.
  const market = {
    up20: universe.filter((q) => q.changePct >= 20).length,
    up100: universe.filter((q) => q.changePct >= 100).length,
  };
  console.log(`  environment: ${market.up100} up >100%, ${market.up20} up >20%`);

  const shortlist = universe.filter(
    (q) =>
      q.price >= PREFILTER.priceMin &&
      q.price <= PREFILTER.priceMax &&
      q.changePct >= PREFILTER.minChangePct &&
      q.volume >= PREFILTER.minVolume,
  );
  console.log(`  pre-filter: ${shortlist.length} worth investigating`);

  const cikMap = await getTickerToCik().catch(() => new Map<string, string>());
  const mfo = minutesFromOpen();
  // Provisional: corrected below from the newest bar we actually see, so the
  // page never claims data is fresher than the bars behind it.
  let asOf = reportedAsOf ?? new Date().toISOString().slice(0, 10);
  const barDates: string[] = [];

  const candidates = await mapLimit(shortlist, CONCURRENCY, async (q: Quote, i): Promise<Candidate | null> => {
    try {
      const bars = await getBars(q.symbol, 550);
      if (bars.length < 10) return null;
      barDates.push(bars.at(-1)!.date);

      // The last bar may be today's session; relative volume must compare
      // today against the days BEFORE it, never against itself.
      const last = bars.at(-1)!;
      const prior = last.date === asOf ? bars.slice(0, -1) : bars;

      const rv = relativeVolume(q.volume, prior);
      const priorClose = prior.at(-1)?.close ?? null;
      const gapPct = priorClose && last.open ? ((last.open - priorClose) / priorClose) * 100 : null;

      const cik = cikMap.get(q.symbol) ?? null;
      const secFloat = cik ? await getFloat(q.symbol, makePriceLookup(bars)).catch(() => null) : null;
      const float = reconcileFloat(secFloat, q.sharesOutstanding, asOf, q.volume);

      const catalyst = await findCatalyst(q.symbol, cik, asOf);
      const rotation = float ? q.volume / float.floatShares : null;

      const gate = gapFilter(q, rv?.rel ?? null, float?.floatShares ?? null, catalyst.found);
      const score = qualityScore({
        quote: q,
        floatShares: float?.floatShares ?? null,
        floatRotation: rotation,
        bestPriorSpikePct: bestSpike(prior.slice(-252)),
        hasNews: catalyst.found,
        market,
        minutesFromOpen: mfo,
        dollarVolume: q.price * q.volume,
      });

      process.stdout.write(`\r  analysed ${i + 1}/${shortlist.length}   `);
      return {
        quote: q,
        float,
        relVolume: rv?.rel ?? null,
        avgVolume50: rv?.avg ?? null,
        floatRotation: rotation,
        gapPct,
        bestPriorSpikePct: bestSpike(prior.slice(-252)),
        dayOfRun: dayOfRun(bars),
        filter,
        score,
        // @ts-expect-error — carried for the UI, not part of the core type
        catalyst,
      };
    } catch {
      return null;
    }
  });

  // The most recent bar any candidate has IS the last completed session.
  // Trust it over the clock: it is derived from the data, not assumed.
  if (barDates.length) {
    const newest = barDates.slice().sort().pop()!;
    if (!reportedAsOf || newest > asOf) asOf = newest;
    else asOf = reportedAsOf;
  }

  const rows = candidates.filter((c): c is Candidate => c !== null);
  rows.sort((a, b) => {
    if (a.filter.passed !== b.filter.passed) return a.filter.passed ? -1 : 1;
    if (b.filter.passedCount !== a.filter.passedCount) return b.filter.passedCount - a.filter.passedCount;
    return b.score.total - a.score.total;
  });

  const payload = {
    generatedAt: startedAt,
    asOf,
    marketOpen: mfo !== null,
    minutesFromOpen: mfo,
    universeSize: universe.length,
    market,
    criteria: CRITERIA,
    rows,
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/screen.json', JSON.stringify(payload, null, 2));

  const full = rows.filter((r) => r.filter.passed);
  console.log(`\n  ${rows.length} analysed — ${full.length} pass all five the momentum source pillars`);
  for (const r of rows.slice(0, 10)) {
    console.log(
      `   ${r.filter.passed ? '✓' : ' '} ${r.quote.symbol.padEnd(6)} ` +
        `$${r.quote.price.toFixed(2).padStart(6)} ${(r.quote.changePct.toFixed(0) + '%').padStart(5)} ` +
        `rvol ${(r.relVolume?.toFixed(1) ?? '—').padStart(6)} ` +
        `float ${(r.float ? (r.float.floatShares / 1e6).toFixed(1) + 'M' : '—').padStart(7)} ` +
        `rot ${(r.floatRotation?.toFixed(1) ?? '—').padStart(6)} ` +
        `| pillars ${r.filter.passedCount}/5  score ${r.score.total}`,
    );
  }
  console.log('\nWrote data/screen.json');
}

main().catch((err) => { console.error(err); process.exit(1); });
