/**
 * SEC EDGAR — the only free source of real float data, and the only one that
 * is safe to build a paid product on (US government works are public domain).
 *
 * EDGAR publishes `dei:EntityPublicFloat`: the market value of shares held by
 * non-affiliates, in DOLLARS, as of a filing date. Both traders talk about
 * float in SHARES, so we divide by the share price on that date — which is why
 * getFloat() takes a price lookup rather than fetching one itself.
 *
 * The number is filed annually, so it goes stale. That is a real limitation and
 * the UI labels it: a float from 11 months ago can be badly wrong after a
 * dilutive raise, which small caps do constantly.
 *
 * SEC's fair-access policy asks for a User-Agent naming a contact. Set
 * SEC_USER_AGENT in .env.local. Without one, EDGAR returns 403.
 */
import type { Float } from '../types.ts';

const UA = process.env.SEC_USER_AGENT ?? 'small-cap-stock-screener (contact: set SEC_USER_AGENT)';

async function secJson(url: string, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;          // plenty of tickers have no filings
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

let tickerMap: Map<string, string> | null = null;

/** ticker -> zero-padded 10-digit CIK. One request, cached for the process. */
export async function getTickerToCik(): Promise<Map<string, string>> {
  if (tickerMap) return tickerMap;
  const json = await secJson('https://www.sec.gov/files/company_tickers.json');
  const map = new Map<string, string>();
  for (const row of Object.values<any>(json ?? {})) {
    if (!row?.ticker || row?.cik_str === undefined) continue;
    map.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  if (!map.size) throw new Error('SEC ticker map came back empty');
  tickerMap = map;
  return map;
}

/**
 * Latest reported public float for one ticker, converted to shares.
 *
 * `priceOn(date)` should return the closing price on or near that ISO date.
 * If it cannot, we return null rather than guess — a float derived from the
 * wrong price is worse than no float at all, because the whole strategy keys
 * off float size.
 */
export async function getFloat(
  symbol: string,
  priceOn: (isoDate: string) => number | null,
): Promise<Float | null> {
  const cik = (await getTickerToCik()).get(symbol.toUpperCase());
  if (!cik) return null;

  const json = await secJson(
    `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityPublicFloat.json`,
  );
  const units: any[] = json?.units?.USD ?? [];
  if (!units.length) return null;

  // Filings restate; take the most recent measurement date.
  const latest = units
    .filter((u) => u?.val > 0 && typeof u?.end === 'string')
    .sort((a, b) => String(a.end).localeCompare(String(b.end)))
    .pop();
  if (!latest) return null;

  const price = priceOn(latest.end);
  if (!price || price <= 0) return null;

  return {
    floatShares: latest.val / price,
    basis: 'sec-public-float',
    asOf: latest.end,
  };
}

/**
 * Fallback when EDGAR has nothing: shares outstanding, from market cap / price.
 * This is an UPPER BOUND on float — insiders and restricted holders are still
 * counted — so it makes a stock look less explosive than it is, never more.
 * Erring in that direction is deliberate: it hides opportunities rather than
 * inventing them.
 */
export function floatFromSharesOutstanding(sharesOutstanding: number | null, asOf: string): Float | null {
  if (!sharesOutstanding || sharesOutstanding <= 0) return null;
  return { floatShares: sharesOutstanding, basis: 'shares-outstanding-proxy', asOf };
}

/**
 * Build the `priceOn` function getFloat() needs, from daily bars.
 *
 * Public float is measured on the last business day of a fiscal year, which is
 * often a date our bar history only just reaches. So we take the nearest bar in
 * either direction, but refuse anything further than `maxGapDays` away — past
 * that, the price has usually moved enough to make the derived share count
 * meaningless, and a wrong float is worse than an absent one.
 */
export function makePriceLookup(
  bars: { date: string; close: number }[],
  maxGapDays = 21,
): (isoDate: string) => number | null {
  if (!bars.length) return () => null;
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  return (isoDate: string) => {
    const target = Date.parse(isoDate + 'T00:00:00Z');
    if (!Number.isFinite(target)) return null;
    let best: { close: number; gap: number } | null = null;
    for (const b of sorted) {
      const gap = Math.abs(Date.parse(b.date + 'T00:00:00Z') - target) / 86_400_000;
      if (!best || gap < best.gap) best = { close: b.close, gap };
    }
    return best && best.gap <= maxGapDays ? best.close : null;
  };
}

/**
 * Shares outstanding straight from EDGAR, in SHARES.
 *
 * Better than deriving a share count from market cap ÷ price, which we saw go
 * badly wrong: Nasdaq's market cap lags reverse splits, and TNON came out
 * implying a 104x float rotation. This concept is reported in share units on
 * every 10-Q and 10-K, so there is no price conversion to get wrong — only
 * staleness, which is bounded by the quarterly filing cycle.
 */
export async function getSharesOutstanding(symbol: string): Promise<{ shares: number; asOf: string } | null> {
  const cik = (await getTickerToCik()).get(symbol.toUpperCase());
  if (!cik) return null;

  const json = await secJson(
    `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`,
  ).catch(() => null);
  const units: any[] = json?.units?.shares ?? [];
  if (!units.length) return null;

  const latest = units
    .filter((u) => u?.val > 0 && typeof u?.end === 'string')
    .sort((a, b) => String(a.end).localeCompare(String(b.end)))
    .pop();
  return latest ? { shares: latest.val, asOf: latest.end } : null;
}
