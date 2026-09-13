/**
 * Seed data/closes.json from the local bar cache -> the last 6 closes per symbol.
 *
 * Without this the run-length check needs six sessions of live snapshots before
 * it can say anything, and the first week of scans would be blind to exactly
 * the over-extension the sources warn about.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';

const DIR = 'data/db/daily';
const out: Record<string, number[]> = {};
for (const f of (await readdir(DIR).catch(() => []))) {
  if (!f.endsWith('.json')) continue;
  try {
    const bars: any[] = JSON.parse(await readFile(`${DIR}/${f}`, 'utf8'));
    const last = bars.slice(-6).map((b) => b.close).filter((c) => c > 0);
    if (last.length >= 2) out[f.replace('.json', '')] = last;
  } catch { /* skip */ }
}
await writeFile('data/closes.json', JSON.stringify(out));
console.log(`Seeded data/closes.json — ${Object.keys(out).length} symbols, ${(JSON.stringify(out).length/1024).toFixed(0)} KB`);
