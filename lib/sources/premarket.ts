/**
 * Live pre-market quotes from Nasdaq's own quote endpoint. Keyless.
 *
 * During the pre-market session Nasdaq returns TWO price blocks per symbol:
 *   primaryData   — the previous session's close
 *   secondaryData — the current pre-market last sale and its % change
 *
 * `secondaryData` is null when the market is shut, which is why this can only
 * be exercised against a live session. Everything here is written to degrade to
 * "no pre-market data" rather than to invent a number.
 *
 * Why not Databento: its historical API only serves data up to the END of the
 * previous day, so it cannot see this morning at any price. Live data there is
 * a separate paid subscription.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type PreMarketQuote = {
  symbol: string;
  /** Pre-market last sale, or null if nothing has traded yet. */
  preMarketPrice: number | null;
  /** Percent change vs the previous close, per Nasdaq. */
  preMarketChangePct: number | null;
  /** Previous session's close. */
  prevClose: number | null;
  /** Nasdaq's own view of the session: "Pre-Market", "Open", "Closed"… */
  marketStatus: string | null;
  /** Volume Nasdaq reports — during pre-market this is the pre-market tally. */
  volume: number | null;
  stale: boolean;
};

function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,%\s+]/g, '');
  if (!cleaned || cleaned === 'N/A' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** One symbol's pre-market state. Returns null on any failure — never a guess. */
export async function getPreMarketQuote(symbol: string, timeoutMs = 12_000): Promise<PreMarketQuote | null> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return null; }
  if (!res.ok) return null;

  let json: any;
  try { json = await res.json(); } catch { return null; }
  const d = json?.data;
  if (!d) return null;

  const primary = d.primaryData ?? {};
  const secondary = d.secondaryData ?? null;
  const status = d.marketStatus ?? null;

  // In pre-market the live print is in secondaryData; primaryData holds the
  // prior close. Outside pre-market there is no secondary block at all.
  const preMarketPrice = secondary ? num(secondary.lastSalePrice) : null;
  const preMarketChangePct = secondary ? num(secondary.percentageChange) : null;

  return {
    symbol: symbol.toUpperCase(),
    preMarketPrice,
    preMarketChangePct,
    prevClose: num(primary.lastSalePrice),
    marketStatus: status,
    volume: num(secondary?.volume ?? primary.volume),
    stale: !secondary,
  };
}

/** Nasdaq's own view of whether we are in pre-market, open, or shut. */
export async function getMarketStatus(): Promise<{ status: string; preMarketOpens: string | null } | null> {
  try {
    const res = await fetch('https://api.nasdaq.com/api/market-info', {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return {
      status: String(j?.data?.marketIndicator ?? 'unknown'),
      preMarketOpens: j?.data?.preMarketOpeningTime ?? null,
    };
  } catch { return null; }
}

export type FetchStats = { requested: number; answered: number; failed: number };

/**
 * Fetch many symbols with bounded concurrency, reporting how many actually
 * answered.
 *
 * The success count is not a nicety. Every failure mode here — Nasdaq blocking
 * the runner, a rate limit, a DNS problem — produces the same visible result as
 * a genuinely quiet morning: an empty shortlist. Without this counter the two
 * are indistinguishable, and the site would report "nothing qualified" every day
 * while actually being broken.
 */
export async function getPreMarketQuotes(
  symbols: string[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<{ quotes: Map<string, PreMarketQuote>; stats: FetchStats }> {
  const out = new Map<string, PreMarketQuote>();
  let next = 0, done = 0, failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, symbols.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= symbols.length) return;
        const q = await getPreMarketQuote(symbols[i]);
        if (q) out.set(q.symbol, q); else failed++;
        done++;
        if (onProgress && done % 50 === 0) onProgress(done, symbols.length);
      }
    }),
  );
  return { quotes: out, stats: { requested: symbols.length, answered: out.size, failed } };
}
