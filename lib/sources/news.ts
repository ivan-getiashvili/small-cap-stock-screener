/**
 * Catalyst detection — the pillar both traders treat as non-negotiable.
 * Cameron: "what comes first is definitely the news catalyst."
 * Sykes: "breaking news + volume + predictable patterns."
 *
 * Two independent signals, because each has a different failure mode:
 *
 *   SEC 8-K   — authoritative and commercially safe, but can lag intraday by
 *               hours (companies have four business days to file).
 *   Nasdaq news — same-day, but its API falls back to generic market articles
 *               when it has nothing for a symbol. Querying a tiny ticker can
 *               return a Broadcom story. So we verify the symbol actually
 *               appears in the article's own symbol fields before believing it.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEC_UA = process.env.SEC_USER_AGENT ?? 'small-cap-stock-screener (contact: set SEC_USER_AGENT)';

export type Catalyst = {
  found: boolean;
  kind: '8-K' | 'news' | null;
  headline: string | null;
  date: string | null;
};

const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000;

/** Most recent 8-K (material event) within `withinDays` of `asOf`. */
export async function secFilingCatalyst(
  cik: string,
  asOf: string,
  withinDays = 3,
): Promise<Catalyst | null> {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': SEC_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const recent = json?.filings?.recent;
  if (!recent?.form) return null;

  for (let i = 0; i < recent.form.length; i++) {
    const form = String(recent.form[i]);
    const date = String(recent.filingDate[i]);
    if (form !== '8-K') continue;
    if (daysBetween(date, asOf) > withinDays) continue;
    return {
      found: true,
      kind: '8-K',
      headline: recent.primaryDocDescription?.[i] ? String(recent.primaryDocDescription[i]) : '8-K current report',
      date,
    };
  }
  return null;
}

/** "Sep 12, 2026" -> "2026-09-12" */
function parseNasdaqDate(s: string): string | null {
  const d = Date.parse(s);
  return Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : null;
}

/** Symbol-verified Nasdaq news within `withinDays` of `asOf`. */
export async function nasdaqNewsCatalyst(
  symbol: string,
  asOf: string,
  withinDays = 2,
): Promise<Catalyst | null> {
  const url =
    `https://api.nasdaq.com/api/news/topic/articlebysymbol` +
    `?q=${encodeURIComponent(symbol)}%7Cstocks&offset=0&limit=10`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const rows: any[] = json?.data?.rows ?? [];
  const want = symbol.toUpperCase();

  for (const r of rows) {
    // The guard that matters: Nasdaq serves unrelated market news as a
    // fallback, so an article only counts if it names this symbol itself.
    const primary = String(r?.primarysymbol ?? '').toUpperCase();
    const related: string[] = (r?.related_symbols ?? []).map((s: string) =>
      String(s).split('|')[0].toUpperCase(),
    );
    if (primary !== want && !related.includes(want)) continue;

    const date = parseNasdaqDate(String(r?.created ?? ''));
    if (!date || daysBetween(date, asOf) > withinDays) continue;
    return { found: true, kind: 'news', headline: String(r?.title ?? '').slice(0, 200), date };
  }
  return null;
}

/** Prefer a same-day headline; fall back to the authoritative filing. */
export async function findCatalyst(
  symbol: string,
  cik: string | null,
  asOf: string,
): Promise<Catalyst> {
  const attempts = [
    () => nasdaqNewsCatalyst(symbol, asOf),
    () => (cik ? secFilingCatalyst(cik, asOf) : Promise.resolve(null)),
  ];
  for (const attempt of attempts) {
    try {
      const hit = await attempt();
      if (hit?.found) return hit;
    } catch { /* one dead feed must not kill the scan */ }
  }
  return { found: false, kind: null, headline: null, date: null };
}
