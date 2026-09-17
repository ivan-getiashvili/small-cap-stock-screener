/**
 * Bake data/premarket.json into page/premarket.html -> _site/index.html
 *
 * The pre-market shortlist is the product, so it takes the index slot. The
 * research page (screener + backtests) is built separately to research.html.
 *
 * The page must read the same for a person and for a machine. Its lists are
 * drawn by JavaScript, which AI readers and crawlers do not run, so the build
 * also writes the full content into the HTML (lib/prerender.ts) and publishes
 * the machine files next to it: llms.txt, history.json, robots.txt, sitemap.xml
 * and a real 404 page.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { renderStatic, renderLlmsTxt, structuredData, SITE } from '../lib/prerender.ts';

const template = await readFile('page/premarket.html', 'utf8');
let data = 'null';
try { data = await readFile('data/premarket.json', 'utf8'); } catch { /* first run */ }

const MARKER = '/*__PREMARKET__*/null';
if (!template.includes(MARKER)) throw new Error(`page/premarket.html is missing ${MARKER}`);

// The track record is optional: the page renders without it on a fresh clone.
let history = 'null';
try { history = await readFile('data/history.json', 'utf8'); } catch { /* none yet */ }

const D = JSON.parse(data), H = JSON.parse(history);
const TITLE = 'Small Cap Screener — pre-market shortlist of small-cap momentum stocks';
const DESCRIPTION = 'A pre-market shortlist of US small-cap momentum stocks, screened on five criteria (pre-market gain, volume, news catalyst, price, float) and rebuilt every 20 minutes before the bell, with the historical run of every flagged name.';

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE}/">
<link rel="alternate" type="text/markdown" href="${SITE}/llms.txt" title="This page as Markdown">
<link rel="alternate" type="application/json" href="${SITE}/premarket.json" title="Latest scan as JSON">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Small Cap Screener">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${SITE}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESCRIPTION}">
<script type="application/ld+json">${structuredData(D)}</script>
</head>
<body>
`;

// Fill the containers the page's script will redraw. Each target must exist
// exactly once, or a template edit has silently broken the machine-readable copy.
const s = renderStatic(D, H);
const fills: [string, string][] = [
  ['<div id="banner"></div>', `<div id="banner">${s.banner}</div>`],
  ['<div id="shortlist"></div>', `<div id="shortlist">${s.shortlist}</div>`],
  ['<div id="watchlist"></div>', `<div id="watchlist">${s.watchlist}</div>`],
  ['<section id="criteria" class="panel"></section>', `<section id="criteria" class="panel">${s.criteria}</section>`],
  // Not hidden in the markup: readers that skip hidden elements must still see
  // the record. The page's script collapses it for people when it loads.
  ['<div id="history" class="panel" hidden></div>', `<div id="history" class="panel">${s.history}</div>`],
  ['<span class="hint" id="history-hint"></span>', `<span class="hint" id="history-hint">${s.hint}</span>`],
];
let body = template;
for (const [from, to] of fills) {
  if (body.split(from).length !== 2) throw new Error(`page/premarket.html: expected exactly one ${from}`);
  body = body.replace(from, () => to);
}

const esc = (j: string) => j.replace(/<\//g, '<\\/');
const html = head +
  body.replace(MARKER, () => esc(data)).replace('/*__HISTORY__*/null', () => esc(history)) +
  '\n</body>\n</html>\n';
await mkdir('_site', { recursive: true });
await writeFile('_site/index.html', html);

// The raw data and the text twin. A reader handed structured data beats it
// scraping our own rendered page, and it costs nothing to emit.
await writeFile('_site/premarket.json', data);
await writeFile('_site/history.json', history);
await writeFile('_site/llms.txt', renderLlmsTxt(D, H));

const aiBots = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'meta-externalagent', 'Amazonbot', 'Bytespider'];
await writeFile('_site/robots.txt',
  `# Everything here is public and meant to be read, by people and by machines.\nUser-agent: *\nAllow: /\n\n# AI crawlers, AI search and AI assistants fetching a link are welcome.\n${aiBots.map((b) => `User-agent: ${b}`).join('\n')}\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
const lastmod = (D?.generatedAt ?? new Date().toISOString()).slice(0, 10);
await writeFile('_site/sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}/</loc><lastmod>${lastmod}</lastmod><changefreq>hourly</changefreq></url>\n  <url><loc>${SITE}/llms.txt</loc><lastmod>${lastmod}</lastmod><changefreq>hourly</changefreq></url>\n</urlset>\n`);
await writeFile('_site/404.html',
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found — Small Cap Screener</title>\n<style>body{margin:0;background:#0a0d12;color:#e8ecf4;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}a{color:#7fb2ff}</style></head>\n<body><div><h1>404 — nothing at this address</h1><p>The shortlist is at <a href="/">smallcapscreener.net</a>. Machine-readable copies: <a href="/llms.txt">llms.txt</a>, <a href="/premarket.json">premarket.json</a>, <a href="/history.json">history.json</a>.</p></div></body></html>\n`);

console.log(`Wrote _site/index.html (${(html.length / 1024).toFixed(0)} KB), premarket.json, history.json, llms.txt, robots.txt, sitemap.xml, 404.html`);
