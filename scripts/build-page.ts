/**
 * Bake data/screen.json into page/template.html -> _site/index.html
 *
 * The output is self-contained: no API calls at view time. That is what lets
 * it be hosted anywhere, and what keeps the project's rule that browser code
 * never talks to a third-party vendor directly.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const template = await readFile('page/template.html', 'utf8');
const data = await readFile('data/screen.json', 'utf8');

/** Optional panels — the page renders without them on a fresh clone. */
async function optional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return 'null'; }
}
const backtest = await optional('data/backtest.json');
const paper = await optional('data/paper.json');
const intraday = await optional('data/backtest-intraday.json');
const sens = await optional('data/sensitivity.json');
const capital = await optional('data/capital.json');

const MARKER = '/*__DATA__*/null';
if (!template.includes(MARKER)) throw new Error(`page/template.html is missing ${MARKER}`);

// `</script>` inside a JSON string would close the surrounding script tag early.
const esc = (j: string) => j.replace(/<\//g, '<\\/');
const safe = esc(data);

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>Small Cap Screener — Cameron × Sykes</title>
</head>
<body>
`;

const html = head +
  template
    .replace(MARKER, safe)
    .replace('/*__BACKTEST__*/null', esc(backtest))
    .replace('/*__PAPER__*/null', esc(paper))
    .replace('/*__INTRADAY__*/null', esc(intraday))
    .replace('/*__SENS__*/null', esc(sens))
    .replace('/*__CAPITAL__*/null', esc(capital)) +
  '\n</body>\n</html>\n';

await mkdir('_site', { recursive: true });
await writeFile('_site/index.html', html);
console.log(`Wrote _site/index.html (${(html.length / 1024).toFixed(0)} KB)`);
