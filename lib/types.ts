/**
 * The shapes the screener works in. No vendor field names past this file.
 *
 * Both traders' criteria are ultimately about four things — how much a stock
 * moved, how much it traded, how many shares exist, and why it moved. Every
 * adapter in lib/sources/ has to express itself in those terms.
 */

/** One row of the whole-market snapshot: where a stock is right now. */
export type Quote = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;      // % change on the day
  volume: number;         // shares traded so far today
  marketCap: number | null;
  sector: string | null;
  industry: string | null;
  ipoYear: number | null;
  /** marketCap / price. Shares outstanding, not float — float is <= this. */
  sharesOutstanding: number | null;
};

/** One daily OHLCV bar. `date` is ISO `YYYY-MM-DD`. */
export type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** What we know about a stock's tradable supply. */
export type Float = {
  /** Shares actually available to trade. The number both methodologies care about. */
  floatShares: number;
  /** How we arrived at it — shown in the UI, because precision varies a lot. */
  basis: 'sec-public-float' | 'shares-outstanding-proxy';
  /** ISO date of the filing the number came from. Float data goes stale. */
  asOf: string;
};

/** A stock that survived the filter, with its score and its reasons. */
export type Candidate = {
  quote: Quote;
  float: Float | null;
  /** Today's volume vs the 50-day average. the momentum source's pillar #2. */
  relVolume: number | null;
  avgVolume50: number | null;
  /** Today's volume / float. the scoring source's central metric. */
  floatRotation: number | null;
  /** Open vs prior close, in percent. the momentum source wants >= 2%. */
  gapPct: number | null;
  /** Biggest single-day gain in the last year, %. the scoring source's "history of spiking". */
  bestPriorSpikePct: number | null;
  /** Consecutive up days ending today. the scoring source wants day 1, not day 3. */
  dayOfRun: number | null;
  filter: FilterResult;
  score: Score;
};

/** the momentum source's five pillars are pass/fail, so we record which ones passed. */
export type FilterResult = {
  passed: boolean;
  pillars: { name: string; ok: boolean; detail: string }[];
  passedCount: number;
};

/** the scoring source scores 1-N per indicator and sums to 100. */
export type Score = {
  total: number;
  tradeable: boolean;   // his rule: only above 70
  parts: { key: string; label: string; points: number; max: number; why: string }[];
};

/** Wraps a source call so one dead vendor cannot take down the whole ingest. */
export async function tolerate<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`  ! ${label} failed: ${(err as Error).message} — continuing without it`);
    return null;
  }
}
