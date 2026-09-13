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
/** [50-day average volume, best single-day gain in the last year] per symbol. */
const out: Record<string, [number, number | null]> = {};
let skipped = 0;

for (const f of (await readdir(DIR).catch(() => []))) {
  if (!f.endsWith('.json')) continue;
  try {
    const bars: any[] = JSON.parse(await readFile(`${DIR}/${f}`, 'utf8'));
    const w = bars.slice(-50);
    if (w.length < 10) { skipped++; continue; }
    const avg = w.reduce((a, b) => a + b.volume, 0) / w.length;
    if (!(avg > 0)) { skipped++; continue; }

    // the scoring source's "history of spiking": has this name run before?
    // Anything over 300% in one session is a reverse split, not a run — these
    // bars are not split-adjusted, and a corporate action would otherwise put a
    // fictitious track record on the card.
    let best: number | null = null;
    const year = bars.slice(-252);
    for (let i = 1; i < year.length; i++) {
      const p = ((year[i].close - year[i - 1].close) / year[i - 1].close) * 100;
      if (p > 300) continue;
      if (best === null || p > best) best = p;
    }
    out[f.replace('.json', '')] = [Math.round(avg), best === null ? null : Math.round(best)];
  } catch { skipped++; }
}

await writeFile('data/stats.json', JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`Wrote data/stats.json — ${Object.keys(out).length} symbols, ${kb} KB (${skipped} skipped)`);
