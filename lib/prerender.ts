/**
 * The page's content as plain HTML and as Markdown, written at build time.
 *
 * Why this exists: the page draws its lists with JavaScript, and AI readers,
 * search crawlers and link previewers do not run JavaScript. Tested on
 * 2026-09-17, a fetch of the live page gave a reader 142 characters — the title
 * and a subtitle — and an AI asked to read it reported every list "not present".
 * So the build writes the same facts into the HTML itself, as headings, lists
 * and tables; in a browser the page's script replaces them with the designed
 * version before the first paint. The Markdown twin is served as /llms.txt.
 *
 * Every string from outside (company names, headlines) is escaped.
 */
export const SITE = 'https://smallcapscreener.net';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const usd = (n: number) => `$${Number(n).toFixed(2)}`;
const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
const sh = (n: number | null | undefined) => (n == null ? 'unknown' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(Math.round(n)));
const mult = (n: number | null | undefined) => (n == null ? 'unknown' : `${Number(n).toFixed(1)}×`);
const etTime = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

type Row = any;

/** The facts about one flagged stock, as label/value pairs, shared by both formats. */
function facts(r: Row): [string, string][] {
  const out: [string, string][] = [
    ['Pre-market move', `${pct(r.preMarketChangePct)} to ${usd(r.preMarketPrice)}${r.prevClose ? ` (previous close ${usd(r.prevClose)})` : ''}`],
    ['Pre-market volume', `${sh(r.preMarketVolume)} shares${r.preMarketDollarVolume ? `, $${sh(r.preMarketDollarVolume)} traded` : ''}`],
    ['Relative volume', `${mult(r.relVolume)} a normal full day's volume (50-day average ${sh(r.avgVolume50)} shares)`],
    ['Float', r.float ? `${sh(r.float.shares)} shares (${r.float.basis === 'sec-public-float' ? 'public float filed with the SEC' : 'shares outstanding, an upper bound'}, as of ${r.float.asOf})` : 'unknown'],
    ['Float rotation', mult(r.floatRotation)],
    ['Market cap', r.marketCap ? `$${sh(r.marketCap)}` : 'unknown'],
    ['Day of the run', r.daysUp != null ? `day ${r.daysUp + 1}${r.extended ? ' — already extended over several sessions' : ''}` : 'unknown'],
    ['Catalyst', r.catalyst?.found ? `${r.catalyst.subject || (r.catalyst.kind === '8-K' ? 'SEC filing' : 'News')}${r.catalyst.headline && r.catalyst.headline !== r.catalyst.subject ? ` — ${r.catalyst.headline.trim()}` : ''} (${r.catalyst.kind === '8-K' ? 'SEC 8-K' : 'headline'}${r.catalyst.date ? `, ${r.catalyst.date}` : ''})` : 'none found'],
    ['Criteria', (r.checks ?? []).map((c: any) => `${c.ok ? 'pass' : 'FAIL'}: ${c.name} (${c.detail})`).join('; ')],
  ];
  return out;
}

function scoredHistory(history: any) {
  const days = Object.values<any>(history?.days ?? {}).filter((d) => d.names?.length).sort((a, b) => b.date.localeCompare(a.date));
  const rows = days.flatMap((d) => d.names.map((n: any) => ({ day: d, n })));
  const scored = rows.filter(({ n }) => n.performance && n.preMarketPrice > 0);
  const runs = scored.map(({ n }) => (n.performance.high / n.preMarketPrice - 1) * 100);
  return { days, rows, scored, runs, sessions: new Set(scored.map(({ day }) => day.date)).size };
}

export function renderStatic(d: any, history: any): Record<'banner' | 'shortlist' | 'watchlist' | 'criteria' | 'history' | 'hint', string> {
  if (!d) return { banner: '<p>No scan has run yet.</p>', shortlist: '', watchlist: '', criteria: '', history: '', hint: '' };
  const g = d.gate;
  const banner = `<p class="static-status">Scan of ${esc(etTime(d.generatedAt))}. Nasdaq market status: ${esc(d.marketStatus || 'unknown')}. `
    + `${Number(d.universeChecked).toLocaleString('en-US')} symbols in the universe, ${d.investigated ?? 0} movers investigated`
    + `${d.fetch?.requested ? `, ${d.fetch.answerRatePct.toFixed(0)}% of quote requests answered` : ''}. `
    + `${d.shortlist.length} trade candidate${d.shortlist.length === 1 ? '' : 's'} (all five criteria), ${d.watchlist.length} on the watchlist (four of five).</p>`;

  const stock = (r: Row, i?: number) => `<article class="static-stock"><h3>${i != null ? `${i + 1}. ` : ''}${esc(r.symbol)} — ${esc(r.legalName || r.name || '')}</h3>`
    + `${r.business ? `<p>${esc(r.business)}</p>` : ''}<ul>${facts(r).map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('')}</ul></article>`;

  const shortlist = `<section class="static"><h2>Trade candidates — all five criteria met (${d.shortlist.length})</h2>`
    + (d.shortlist.length ? d.shortlist.map((r: Row, i: number) => stock(r, i)).join('') : '<p>No stock cleared all five criteria in this scan. That is a normal outcome.</p>') + '</section>';
  const watchlist = d.watchlist.length
    ? `<section class="static"><h2>Watchlist — four of five criteria, not trade candidates (${d.watchlist.length})</h2>${d.watchlist.map((r: Row) => stock(r)).join('')}</section>` : '';

  const criteria = `<h2>How it screens</h2>
    <div class="lede">Five criteria, all of which must pass to reach the shortlist. Four of five puts a name on the watchlist, with the missing one named.</div>
    <div class="crit">
      <div><b>≥ ${g.minPreMarketChangePct}%</b><small>up pre-market vs previous close</small></div>
      <div><b>≥ ${g.minPreMarketVolume / 1000}k shares</b><small>pre-market volume</small></div>
      <div><b>News catalyst</b><small>a filing or release behind the move</small></div>
      <div><b>$${g.priceMin} – $${g.priceMax}</b><small>price</small></div>
      <div><b>&lt; ${g.floatIdeal / 1e6}M shares</b><small>float</small></div>
    </div>
    <p><b>Quality.</b> Float under ${g.floatStretch / 1e6}M with pre-market volume over ${g.goodPreMarketVolume / 1000}k is high quality; volume under ${g.minPreMarketVolume / 1000}k is low. Percent gainers rank first, then catalyst and float, so the list ends with a handful of names rather than twenty.</p>
    <p><b>Fresh moves only.</b> The percentage is this session against the previous close. A name that has already climbed for several sessions is marked <b>extended</b>: a stock up 100% in one morning on new information is the setup; one up 100% over three sessions is usually a squeeze that has already happened.</p>
    <p><b>What this is not.</b> It finds candidates; it decides nothing. Entry, size and stop are yours. Float is the weakest number here — the SEC files it once a year and small caps dilute constantly — so anything marked estimated should be checked before sizing a position.</p>`;

  const h = scoredHistory(history);
  const hint = h.runs.length ? `${h.scored.length} names over ${h.sessions} sessions · median run to the high ${pct(median(h.runs))}` : '';
  const historyHtml = !h.rows.length ? '' : `<div class="lede">How far every flagged name ran from the price the list showed to the high of that session. Scored after the close; nothing is filtered out.</div>`
    + (h.runs.length ? `<p class="static-status">${h.scored.length} flagged names scored over ${h.sessions} sessions. Average run from the flag price to the high of the day: ${pct(mean(h.runs))}. Median: ${pct(median(h.runs))}.</p>` : '')
    + `<div class="static-scroll"><table class="static-table"><thead><tr><th>Date</th><th>Ticker</th><th>Company</th><th>List</th><th>Price when flagged</th><th>High of that day</th><th>Run to the high</th><th>Record</th></tr></thead><tbody>`
    + h.rows.map(({ day, n }) => `<tr><td>${esc(day.date)}</td><td>${esc(n.symbol)}</td><td>${esc([n.legalName, n.business].filter(Boolean).join(' · '))}</td><td>${n.list === 'shortlist' ? 'trade candidate' : 'watchlist'}</td><td>${usd(n.preMarketPrice)}</td>`
      + (n.performance ? `<td>${usd(n.performance.high)}</td><td>${pct((n.performance.high / n.preMarketPrice - 1) * 100)}</td>` : '<td colspan="2">scored after the close</td>')
      + `<td>${day.source === 'replay' ? 'replay' : 'live'}</td></tr>`).join('')
    + '</tbody></table></div>';

  return { banner, shortlist, watchlist, criteria, history: historyHtml, hint };
}

/** /llms.txt — the whole page as Markdown, for readers that prefer text. */
export function renderLlmsTxt(d: any, history: any): string {
  const L: string[] = [];
  L.push('# Small Cap Screener', '');
  L.push('> A pre-market shortlist of US small-cap momentum stocks, rebuilt every 20 minutes through the pre-market session (04:00–09:30 ET) on weekdays, with a historical record of how far every flagged stock ran afterwards. It finds candidates; it is not a trading system and not investment advice.', '');
  L.push(`- Page: ${SITE}/`, `- Latest scan as JSON: ${SITE}/premarket.json`, `- Full historical record as JSON: ${SITE}/history.json`, `- This file: ${SITE}/llms.txt`, '');
  if (!d) { L.push('No scan has run yet.'); return L.join('\n') + '\n'; }
  const g = d.gate;
  L.push('## How it screens', '');
  L.push('All five criteria must pass for a stock to be a trade candidate; four of five puts it on the watchlist with the missing criterion named.', '');
  L.push(`1. Up at least ${g.minPreMarketChangePct}% in pre-market trading against the previous close.`, `2. At least ${g.minPreMarketVolume.toLocaleString('en-US')} shares traded pre-market.`, '3. A news catalyst: an SEC 8-K filing or a press release behind the move.', `4. Price between $${g.priceMin} and $${g.priceMax}.`, `5. Float under ${g.floatIdeal / 1e6} million shares (shares outstanding is used as an upper bound when the SEC public float is unavailable).`, '');
  L.push(`Float under ${g.floatStretch / 1e6}M with pre-market volume over ${g.goodPreMarketVolume.toLocaleString('en-US')} is high quality. A stock that has already risen for several sessions is marked "extended". Sources: Nasdaq public quote endpoints; SEC EDGAR for share counts, float and 8-K filings; PR Newswire and GlobeNewswire feeds.`, '');
  L.push('## Latest scan', '');
  L.push(`- Scanned: ${etTime(d.generatedAt)} (${d.generatedAt})`, `- Nasdaq market status: ${d.marketStatus || 'unknown'}`, `- Universe: ${Number(d.universeChecked).toLocaleString('en-US')} symbols; ${d.investigated ?? 0} movers investigated${d.fetch?.requested ? `; ${d.fetch.answerRatePct.toFixed(0)}% of quote requests answered` : ''}`, `- Live pre-market quotes: ${d.liveQuotes ?? 0}${d.fetch && !d.fetch.reliable ? ' — THIS SCAN IS UNRELIABLE: too few quotes answered, an empty list does not mean nothing qualified' : ''}`, '');
  const block = (title: string, rows: Row[], empty: string) => {
    L.push(`### ${title} (${rows.length})`, '');
    if (!rows.length) { L.push(empty, ''); return; }
    for (const r of rows) { L.push(`#### ${r.symbol} — ${r.legalName || r.name || ''}`, ''); if (r.business) L.push(r.business, ''); for (const [k, v] of facts(r)) L.push(`- ${k}: ${v}`); L.push(''); }
  };
  block('Trade candidates — all five criteria met', d.shortlist, 'No stock cleared all five criteria in this scan. That is a normal outcome.');
  block('Watchlist — four of five criteria', d.watchlist, 'Nothing on the watchlist.');
  const h = scoredHistory(history);
  L.push('## Historical performance', '');
  if (h.runs.length) {
    L.push(`Every stock the list has shown, scored after the close: how far it ran from the pre-market price shown when it was flagged to the high of that same day. Nothing is filtered out; "replay" rows were reconstructed from historical minute data under the same rules, "live" rows were flagged by the running site.`, '');
    L.push(`- Names scored: ${h.scored.length} over ${h.sessions} sessions`, `- Average run from the flag price to the high of the day: ${pct(mean(h.runs))}`, `- Median run: ${pct(median(h.runs))}`, '');
    L.push('| Date | Ticker | Company | List | Price when flagged | High of that day | Run to the high | Record |', '|---|---|---|---|---|---|---|---|');
    for (const { day, n } of h.rows) L.push(`| ${day.date} | ${n.symbol} | ${[n.legalName, n.business].filter(Boolean).join(' · ').replace(/\|/g, '/')} | ${n.list === 'shortlist' ? 'trade candidate' : 'watchlist'} | ${usd(n.preMarketPrice)} | ${n.performance ? usd(n.performance.high) : '—'} | ${n.performance ? pct((n.performance.high / n.preMarketPrice - 1) * 100) : 'scored after the close'} | ${day.source === 'replay' ? 'replay' : 'live'} |`);
    L.push('');
  } else L.push('No sessions scored yet.', '');
  return L.join('\n') + '\n';
}

export function structuredData(d: any): string {
  const desc = 'A pre-market shortlist of US small-cap momentum stocks screened on five criteria — pre-market gain, volume, news catalyst, price and float — with a historical record of how far each flagged stock ran.';
  const graph = [
    { '@type': 'WebSite', '@id': `${SITE}/#site`, name: 'Small Cap Screener', url: `${SITE}/`, description: desc, inLanguage: 'en' },
    { '@type': 'Dataset', '@id': `${SITE}/#dataset`, name: 'Pre-market shortlist of small-cap momentum stocks', description: desc, url: `${SITE}/`, isAccessibleForFree: true, dateModified: d?.generatedAt ?? undefined,
      creator: { '@type': 'Organization', name: 'Small Cap Screener', url: `${SITE}/` },
      distribution: [
        { '@type': 'DataDownload', name: 'Latest scan', encodingFormat: 'application/json', contentUrl: `${SITE}/premarket.json` },
        { '@type': 'DataDownload', name: 'Historical record', encodingFormat: 'application/json', contentUrl: `${SITE}/history.json` },
        { '@type': 'DataDownload', name: 'The page as Markdown', encodingFormat: 'text/markdown', contentUrl: `${SITE}/llms.txt` },
      ] },
  ];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/<\//g, '<\\/');
}
