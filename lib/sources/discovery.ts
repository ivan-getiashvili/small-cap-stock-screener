/**
 * Which symbols are worth a live quote this morning.
 *
 * Nasdaq publishes no free live pre-market list, and live quotes cost one
 * request per symbol — asking about all ~3,400 small caps got us blocked. So
 * the scan starts from the stocks that have a reason to move. Every shortlist
 * name must have a catalyst anyway, so starting from the catalysts applies that
 * filter first instead of last, and cuts the lookups to a few dozen.
 *
 * Sources, measured on 2026-09-14:
 *   SEC 8-K feed    — authoritative; 94 filings after Friday's close, 51 of them
 *                     small caps in our price band. Lags press releases.
 *   PR Newswire     — same-morning releases with tickers, but each feed shows
 *                     only its latest 20 items, so a busy half hour can overflow.
 *   GlobeNewswire   — would not connect from the Mac; tried anyway, failure OK.
 *   Prior-session gainers — yesterday's runners, which often move again.
 * Not used: Business Wire (no tickers in its feed, release pages refuse us) and
 * Accesswire (behind a bot challenge).
 *
 * Known blind spot: a microcap whose news breaks only on a wire we cannot read,
 * before it files an 8-K.
 */
import { getTickerToCik } from './sec.ts';
import { classify } from './news.ts';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEC_UA = process.env.SEC_USER_AGENT ?? 'small-cap-stock-screener (contact: set SEC_USER_AGENT)';

export type LeadSource = '8-K' | 'PR Newswire' | 'GlobeNewswire' | 'prior-session gainer';
export type Lead = {
  symbol: string;
  source: LeadSource;
  at: string | null;          // ISO time the news or filing appeared
  headline: string | null;
  subject: string | null;
};

/**
 * Fetch with a few retries. These feeds are flaky rather than blocked: PR
 * Newswire's main feed answered 404, 200, 404 to three identical requests a few
 * seconds apart on 2026-09-14. One failed attempt should not cost a morning's
 * leads.
 */
async function fetchText(url: string, headers: Record<string, string>, timeoutMs = 30_000, attempts = 3): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.text();
    } catch { /* retry */ }
  }
  return null;
}

const decode = (s: string) => s
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** 8-K filings accepted since `sinceMs`, mapped to every ticker their filer trades under. */
export async function edgarLeads(sinceMs: number): Promise<{ leads: Lead[]; filings: number; ok: boolean }> {
  const tickerToCik = await getTickerToCik();
  const cikToTickers = new Map<string, string[]>();
  for (const [ticker, cik] of tickerToCik) {
    const key = cik.replace(/^0+/, '');
    if (!cikToTickers.has(key)) cikToTickers.set(key, []);
    cikToTickers.get(key)!.push(ticker);
  }

  const leads: Lead[] = [];
  let filings = 0, ok = true;
  for (let start = 0; start < 600; start += 100) {
    const xml = await fetchText(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=${start}&count=100&output=atom`,
      { 'User-Agent': SEC_UA, Accept: 'application/atom+xml' },
    );
    if (xml === null) { ok = start > 0; break; }
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    if (!entries.length) break;

    let oldest = Infinity;
    for (const e of entries) {
      const title = decode(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? '');
      const t = Date.parse(/<updated>([\s\S]*?)<\/updated>/.exec(e)?.[1] ?? '');
      if (!Number.isFinite(t)) continue;
      oldest = Math.min(oldest, t);
      const form = title.split(' - ')[0].trim();
      if (form !== '8-K' && form !== '8-K/A') continue;
      if (t < sinceMs) continue;
      filings++;
      const cik = /\((\d{10})\)/.exec(title)?.[1]?.replace(/^0+/, '');
      for (const symbol of (cik && cikToTickers.get(cik)) || []) {
        leads.push({ symbol, source: '8-K', at: new Date(t).toISOString(), headline: null, subject: null });
      }
    }
    if (oldest < sinceMs) break;          // the feed is newest-first; we are past the window
  }
  return { leads, filings, ok };
}

/**
 * Exchange tickers as press releases write them: "(NASDAQ: ABCD)",
 * "(Nasdaq: ABCD)", "(NYSE American: XYZ)". OTC names are ignored because the
 * screen covers listed stocks only.
 */
const WIRE_TICKER = /\b(?:NASDAQ|Nasdaq|NasdaqCM|NasdaqGM|NasdaqGS|NYSE American|NYSE MKT|NYSE Arca|NYSE)\s*:\s*([A-Z]{1,5})\b/g;

const FEEDS: [LeadSource, string][] = [
  ['PR Newswire', 'https://www.prnewswire.com/rss/news-releases-list.rss'],
  ['PR Newswire', 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss'],
  ['GlobeNewswire', 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies'],
];

export type FeedResult = { name: LeadSource; url: string; ok: boolean; items: number; inWindow: number };

/** Press releases published since `sinceMs` that name a listed ticker. */
export async function wireLeads(sinceMs: number): Promise<{ leads: Lead[]; feeds: FeedResult[] }> {
  const results = await Promise.all(FEEDS.map(async ([name, url]) => {
    const xml = await fetchText(url, { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml' }, 20_000);
    const leads: Lead[] = [];
    if (xml === null) return { feed: { name, url, ok: false, items: 0, inWindow: 0 }, leads };
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    let inWindow = 0;
    for (const item of items) {
      const t = Date.parse(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1] ?? '');
      if (!Number.isFinite(t) || t < sinceMs) continue;
      inWindow++;
      const headline = decode(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '');
      const symbols = new Set([...item.matchAll(WIRE_TICKER)].map((m) => m[1]));
      for (const symbol of symbols) {
        leads.push({ symbol, source: name, at: new Date(t).toISOString(), headline, subject: classify(headline) });
      }
    }
    return { feed: { name, url, ok: true, items: items.length, inWindow }, leads };
  }));
  return { leads: results.flatMap((r) => r.leads), feeds: results.map((r) => r.feed) };
}
