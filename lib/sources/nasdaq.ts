/**
 * Nasdaq's own public market-data endpoints. Keyless.
 *
 * Two calls matter:
 *   getUniverse()  — every US-listed stock in ONE request, with today's price,
 *                    % change, volume and market cap. This is what makes a
 *                    whole-market scan cheap enough to run every few minutes.
 *   getBars()      — daily OHLCV for one symbol, for the 50-day average volume
 *                    (relative volume) and for the backtest.
 *
 * Nasdaq wants a browser-ish User-Agent; without one it returns an empty body.
 */
import type { Quote, Bar } from '../types.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Nasdaq throttles aggressively and answers with 403 rather than 429 when it
 * decides you have asked too often. That is recoverable if you wait, so back
 * off and retry instead of failing the whole scan on one refusal.
 */
async function getJson(url: string, timeoutMs = 45_000, attempts = 3): Promise<any> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));  // 2s, 4s
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 403 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} from api.nasdaq.com (throttled)`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from api.nasdaq.com`);
      return res.json();
    } catch (e) {
      lastErr = e as Error;
      if ((e as Error).name === 'AbortError') continue;
      if (i === attempts - 1) throw e;
    }
  }
  throw lastErr ?? new Error('nasdaq request failed');
}

/** "$146.93" -> 146.93 ; "2.662%" -> 2.662 ; "50,716,870" -> 50716870 ; "N/A" -> null */
function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === 'N/A' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * The entire US listed market in one request (~2 MB, ~4,000 rows once ETFs
 * and funds are dropped). `download=true` is the flag that adds the volume
 * column — without it the response has price and market cap but no volume,
 * which would make relative volume impossible.
 */
export async function getUniverse(): Promise<{ quotes: Quote[]; asOf: string | null }> {
  const url =
    'https://api.nasdaq.com/api/screener/stocks' +
    '?tableonly=false&limit=25000&offset=0&download=true';
  const json = await getJson(url);
  const rows: any[] = json?.data?.rows ?? [];
  if (!rows.length) throw new Error('Nasdaq screener returned no rows');

  // Which session do these prices belong to? The download=true response omits
  // that field, so we ask the small variant that carries it. Returning null
  // when it is unavailable is deliberate: defaulting to "today" would label
  // Friday's closes as Saturday's, which is the quiet-staleness failure this
  // project forbids. The caller derives a date from real bar data instead.
  const asOf = await getAsOf().catch(() => null);

  const out: Quote[] = [];
  for (const r of rows) {
    const symbol = String(r.symbol ?? '').trim().toUpperCase();
    const price = num(r.lastsale);
    const volume = num(r.volume);
    const changePct = num(r.pctchange);
    // A stock with no price or no volume cannot be screened on any criterion
    // either trader uses, so it is dropped here rather than checked everywhere.
    if (!symbol || price === null || price <= 0 || volume === null) continue;
    // Skip warrants, units, rights and preferreds. the scoring source calls these out
    // explicitly ("I don't like trading stocks with a W"), and they distort
    // float maths because they are claims on shares rather than shares.
    if (/[.^]|\/(W|U|R|P)/.test(symbol) || /\b(warrant|unit|right|preferred|depositary)\b/i.test(String(r.name ?? ''))) continue;

    const marketCap = num(r.marketCap);
    out.push({
      symbol,
      name: String(r.name ?? '').replace(/\s+Common Stock$/i, '').trim(),
      price,
      changePct: changePct ?? 0,
      volume,
      marketCap: marketCap && marketCap > 0 ? marketCap : null,
      sector: r.sector ? String(r.sector) : null,
      industry: r.industry ? String(r.industry) : null,
      ipoYear: num(r.ipoyear),
      sharesOutstanding: marketCap && marketCap > 0 ? marketCap / price : null,
    });
  }
  return { quotes: out, asOf };
}

/** The trading session Nasdaq's prices belong to, or null if it won't say. */
async function getAsOf(): Promise<string | null> {
  const json = await getJson(
    'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=1&offset=0&download=false',
    20_000,
  );
  return parseAsOf(String(json?.data?.asof ?? ''));
}

/**
 * "Sep 11, 2026" -> "2026-09-11", built from the text itself.
 *
 * Date.parse on that string yields LOCAL midnight, and toISOString then shifts
 * it to UTC — on a machine east of UTC that lands on the previous day. That is
 * how a Saturday run on the Mac reported Friday's prices as "as of 2026-09-10".
 */
function usDateToIso(raw: string): string | null {
  const m = /([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(raw);
  if (!m) return null;
  const mi = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[1]);
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** "Last price as of Sep 11, 2026" -> "2026-09-11" */
function parseAsOf(raw: string): string | null {
  return usDateToIso(raw);
}

/** "09/11/2026" -> "2026-09-11" */
function isoDate(us: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(us.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * Daily bars for one symbol, newest first from Nasdaq, returned oldest first.
 * `days` is calendar days to look back, not trading days.
 */
export async function getBars(symbol: string, days = 120): Promise<Bar[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical` +
    `?assetclass=stocks&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=${days + 10}`;

  const json = await getJson(url);
  const rows: any[] = json?.data?.tradesTable?.rows ?? [];
  const bars: Bar[] = [];
  for (const r of rows) {
    const date = isoDate(String(r.date ?? ''));
    const close = num(r.close);
    const open = num(r.open);
    const high = num(r.high);
    const low = num(r.low);
    const volume = num(r.volume);
    if (!date || close === null || volume === null) continue;
    bars.push({ date, open: open ?? close, high: high ?? close, low: low ?? close, close, volume });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}
