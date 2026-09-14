/**
 * Catalyst detection — the pillar both methodologies treat as non-negotiable.
 * the momentum source: "what comes first is definitely the news catalyst."
 * the scoring source: "breaking news + volume + predictable patterns."
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
  /** Plain-English subject: "Merger or acquisition", "Earnings", … */
  subject: string | null;
};

/**
 * What an 8-K is actually about.
 *
 * A filing on its own only tells you something material happened. The item
 * numbers say WHAT, and that is the difference between "there is news" and
 * "they signed a merger agreement" — which is the thing you actually need
 * before deciding whether a move is worth trading.
 */
const EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'Entered a material agreement (deal, partnership or contract)',
  '1.02': 'Terminated a material agreement',
  '1.03': 'Bankruptcy or receivership',
  '1.05': 'Material cybersecurity incident',
  '2.01': 'Completed an acquisition or disposal of assets',
  '2.02': 'Earnings / results released',
  '2.03': 'Took on a material financial obligation (debt)',
  '2.04': 'Triggered an obligation to repay debt early',
  '2.05': 'Committed to a restructuring or exit plan',
  '3.01': 'Delisting notice or listing-rule failure',
  '3.02': 'Sold unregistered shares (dilution)',
  '3.03': 'Changed the rights of shareholders',
  '4.01': 'Changed auditors',
  '4.02': 'Previously issued financials should no longer be relied on',
  '5.01': 'Change of control of the company',
  '5.02': 'Executive or board change',
  '5.03': 'Amended the charter or bylaws',
  '5.07': 'Shareholder vote results',
  '7.01': 'Regulation FD disclosure (company announcement)',
  '8.01': 'Other material event (often FDA, clinical or contract news)',
  '9.01': 'Financial statements and exhibits',
};

/** Turn "1.01,9.01" into a readable subject, most meaningful item first. */
export function describeItems(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const codes = String(raw).split(/[,;]/).map((c) => c.trim()).filter(Boolean);
  // 9.01 is boilerplate attached to almost every 8-K; it explains nothing.
  const meaningful = codes.filter((c) => c !== '9.01');
  const described = (meaningful.length ? meaningful : codes)
    .map((c) => EIGHT_K_ITEMS[c])
    .filter(Boolean);
  return described.length ? described.join(' · ') : null;
}

const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000;

/** EDGAR submissions, fetched once per company per process. */
const submissionsCache = new Map<string, any>();

export async function getSubmissions(cik: string): Promise<any | null> {
  if (submissionsCache.has(cik)) return submissionsCache.get(cik);
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { submissionsCache.set(cik, null); return null; }
    const json = await res.json();
    submissionsCache.set(cik, json);
    return json;
  } catch { submissionsCache.set(cik, null); return null; }
}

/**
 * What the company actually does, from its own filings.
 * `sicDescription` is the SEC's industry classification — "Pharmaceutical
 * Preparations", "Services-Computer Programming" — which is the shortest honest
 * answer to "what is this business?" available without a paid data vendor.
 */
export async function getCompanyProfile(cik: string): Promise<{ name: string | null; business: string | null } | null> {
  const json = await getSubmissions(cik);
  if (!json) return null;
  return {
    name: json.name ? String(json.name) : null,
    business: json.sicDescription ? String(json.sicDescription) : null,
  };
}

/** Most recent 8-K (material event) within `withinDays` of `asOf`. */
export async function secFilingCatalyst(
  cik: string,
  asOf: string,
  withinDays = 3,
): Promise<Catalyst | null> {
  const json = await getSubmissions(cik);
  if (!json) return null;
  const recent = json?.filings?.recent;
  if (!recent?.form) return null;

  for (let i = 0; i < recent.form.length; i++) {
    const form = String(recent.form[i]);
    const date = String(recent.filingDate[i]);
    if (form !== '8-K') continue;
    if (daysBetween(date, asOf) > withinDays) continue;
    const subject = describeItems(recent.items?.[i]);
    return {
      found: true,
      kind: '8-K',
      // primaryDocDescription is almost always the generic "CURRENT REPORT",
      // so prefer the decoded item subject when we have one.
      headline: subject ?? (recent.primaryDocDescription?.[i]
        ? String(recent.primaryDocDescription[i]) : '8-K current report'),
      subject,
      date,
    };
  }
  return null;
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

/** "Sep 12, 2026" -> "2026-09-12" */
function parseNasdaqDate(s: string): string | null {
  return usDateToIso(s);
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
    const title = String(r?.title ?? '').slice(0, 220);
    return { found: true, kind: 'news', headline: title, subject: classify(title), date };
  }
  return null;
}

/**
 * Bucket a headline by what kind of event it describes.
 *
 * Crude keyword matching, and it says so — but "FDA approval" and "reverse
 * split" move a stock in opposite directions, and knowing which you are looking
 * at matters more than the elegance of the method.
 */
export function classify(title: string): string | null {
  const t = title.toLowerCase();
  const rules: [RegExp, string][] = [
    [/fda|approval|phase\s*(1|2|3|i{1,3})\b|clinical|trial|nda|510\(k\)/, 'FDA / clinical'],
    [/merger|acquir|acquisition|takeover|buyout|to be acquired|definitive agreement/, 'Merger or acquisition'],
    [/earnings|results|revenue|guidance|quarter|beats|misses/, 'Earnings or guidance'],
    [/contract|award|order|partnership|collaborat|agreement|deal with|selected by/, 'Contract or partnership'],
    [/offering|dilut|priced|registered direct|atm |shelf|warrant|convertible/, 'Share offering (dilution)'],
    [/reverse split|split/, 'Stock split'],
    [/short squeeze|squeeze|short interest/, 'Short squeeze chatter'],
    [/bankrupt|chapter 11|delist|going concern/, 'Distress or delisting'],
    [/patent|licens/, 'Patent or licensing'],
    [/crypto|bitcoin|blockchain|ai |artificial intelligence|quantum/, 'Hot-sector announcement'],
  ];
  for (const [re, label] of rules) if (re.test(t)) return label;
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
  return { found: false, kind: null, headline: null, subject: null, date: null };
}
