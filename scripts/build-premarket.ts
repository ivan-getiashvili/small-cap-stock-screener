/**
 * Bake data/premarket.json into page/premarket.html -> _site/index.html
 *
 * The pre-market shortlist is the product, so it takes the index slot. The
 * research page (screener + backtests) is built separately to research.html.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const template = await readFile('page/premarket.html', 'utf8');
let data = 'null';
try { data = await readFile('data/premarket.json', 'utf8'); } catch { /* first run */ }

const MARKER = '/*__PREMARKET__*/null';
if (!template.includes(MARKER)) throw new Error(`page/premarket.html is missing ${MARKER}`);

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>Pre-Market Shortlist — small cap momentum</title>
<meta name="description" content="A daily pre-market shortlist of small-cap momentum candidates, screened on five momentum criteria.">
</head>
<body>
`;

const html = head + template.replace(MARKER, data.replace(/<\//g, '<\\/')) + '\n</body>\n</html>\n';
await mkdir('_site', { recursive: true });
await writeFile('_site/index.html', html);

// Publish the raw scan as JSON too. A scheduled agent reading structured data
// beats it scraping our own rendered page, and it costs nothing to emit.
await writeFile('_site/premarket.json', data);

console.log(`Wrote _site/index.html (${(html.length / 1024).toFixed(0)} KB) and _site/premarket.json`);
