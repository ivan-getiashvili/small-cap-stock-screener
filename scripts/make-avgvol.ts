/**
 * Distil the 544 MB daily cache into one small file -> data/avgvol.json
 *
 * Run:  node --experimental-strip-types scripts/make-avgvol.ts
 *
 * The pre-market scan needs a 50-day average volume per symbol to compute
 * relative volume, but the full bar cache is far too large to commit and CI
 * will not have it. Only the average is actually needed, and that is a few
 * hundred kilobytes. Regenerate it whenever the daily cache is refreshed.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';

const DIR = 'data/db/daily';
const out: Record<string, number> = {};
let skipped = 0;

for (const f of (await readdir(DIR).catch(() => []))) {
  if (!f.endsWith('.json')) continue;
  try {
    const bars: any[] = JSON.parse(await readFile(`${DIR}/${f}`, 'utf8'));
    const w = bars.slice(-50);
    if (w.length < 10) { skipped++; continue; }
    const avg = w.reduce((a, b) => a + b.volume, 0) / w.length;
    if (avg > 0) out[f.replace('.json', '')] = Math.round(avg);
  } catch { skipped++; }
}

await writeFile('data/avgvol.json', JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`Wrote data/avgvol.json — ${Object.keys(out).length} symbols, ${kb} KB (${skipped} skipped)`);
