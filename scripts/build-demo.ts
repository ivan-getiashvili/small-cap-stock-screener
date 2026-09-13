/** Bake data/demo.json into the same template -> _site/demo.html */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const template = await readFile('page/premarket.html', 'utf8');
const data = await readFile('data/demo.json', 'utf8');
const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>Pre-Market Shortlist — replay demo</title>
</head>
<body>
`;
const html = head + template.replace('/*__PREMARKET__*/null', data.replace(/<\//g, '<\\/')) + '\n</body>\n</html>\n';
await mkdir('_site', { recursive: true });
await writeFile('_site/demo.html', html);
console.log(`Wrote _site/demo.html (${(html.length / 1024).toFixed(0)} KB)`);
