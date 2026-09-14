/**
 * Live extended-hours quotes from Nasdaq's per-symbol quote endpoint. Keyless.
 *
 * Which block holds what — checked against the 1-minute chart on 2026-09-14,
 * because the first version had it backwards:
 *
 *   primaryData   — the LIVE print. During pre-market it is the latest trade,
 *                   `isRealTime: true`, stamped today ("Sep 14, 2026 5:56 AM
 *                   ET"), with the session's volume so far. AAPL read $331.2196
 *                   here and on the chart at 5:56 AM.
 *   secondaryData — not trustworthy. Usually the previous session's close
 *                   ("Closed at Sep 11, 2026 4:00 PM ET"), but for SXTC it
 *                   repeated the live price. Never read.
 *
 * Reading the blocks backwards turned Friday's regular-session change into
 * "this morning's pre-market move" and still called the quote live. So a quote
 * counts as live only when it is real-time AND stamped with today's New York
 * date, and the caller measures the move against a close we stored ourselves.
 *
 * Why not the bulk screener: during pre-market every one of its 6,090 prices
 * still equals the previous close, and Nasdaq's movers lists are stamped with
 * the previous session too. Live pre-market data exists only per symbol, which
 * is why lib/sources/discovery.ts decides which few symbols to ask about.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type LiveQuote = {
  symbol: string;
  /** Latest print in the current session, or null if nothing has traded. */
  price: number | null;
  /** Shares traded so far in the current session. */
  volume: number | null;
  /** Nasdaq's own % change vs the previous close — used only as a cross-check. */
  nasdaqChangePct: number | null;
  /** Nasdaq's words for the session: "Pre-Market", "Open", "Closed"… */
  marketStatus: string | null;
  lastTradeAt: string | null;
  isRealTime: boolean;
  /** Real-time and stamped today in New York. The only quotes a scan may use. */
  live: boolean;
};

function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,%\s+]/g, '');
  if (!cleaned || cleaned === 'N/A' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Today's date as Nasdaq writes it in quote timestamps: "Sep 14, 2026". */
export function nyDateLabel(d = new Date()): string {
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** One symbol's live state. Returns null on any failure — never a guess. */
export async function getPreMarketQuote(symbol: string, timeoutMs = 12_000): Promise<LiveQuote | null> {
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

  const p = d.primaryData ?? {};
  const lastTradeAt = typeof p.lastTradeTimestamp === 'string' ? p.lastTradeTimestamp : null;
  const isRealTime = p.isRealTime === true;
  const stampedToday = !!lastTradeAt && lastTradeAt.startsWith(nyDateLabel());

  return {
    symbol: symbol.toUpperCase(),
    price: num(p.lastSalePrice),
    volume: num(p.volume),
    nasdaqChangePct: num(p.percentageChange),
    marketStatus: d.marketStatus ?? null,
    lastTradeAt,
    isRealTime,
    live: isRealTime && stampedToday,
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
 * Fetch many symbols with bounded concurrency and a small gap between requests,
 * reporting how many actually answered.
 *
 * The success count is not a nicety. Every failure mode here — Nasdaq blocking
 * the runner, a rate limit, a DNS problem — produces the same visible result as
 * a genuinely quiet morning: an empty shortlist. Without this counter the two
 * are indistinguishable. The pacing exists because this endpoint has blocked us
 * before, after a few thousand requests in quick succession.
 */
export async function getPreMarketQuotes(
  symbols: string[],
  concurrency = 3,
  gapMs = 150,
): Promise<{ quotes: Map<string, LiveQuote>; stats: FetchStats }> {
  const out = new Map<string, LiveQuote>();
  let next = 0, failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, symbols.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= symbols.length) return;
        const q = await getPreMarketQuote(symbols[i]);
        if (q) out.set(q.symbol, q); else failed++;
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    }),
  );
  return { quotes: out, stats: { requested: symbols.length, answered: out.size, failed } };
}
