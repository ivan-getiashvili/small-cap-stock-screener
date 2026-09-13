/**
 * Cache minute bars for every candidate day -> data/db/minutes/<DATE>.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-db-minutes.ts [--dry]
 *
 * Split out from the backtest deliberately. The first version pulled and
 * simulated in one pass, which meant every change to the trading rules re-bought
 * the same data. Separating them makes the pull a one-off cost and every
 * subsequent iteration free — which matters, because the rules will be wrong
 * several times before they are right.
 *
 * Resumable: dates already cached are skipped.
 */
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { streamBars, getCost, MINUTE_DATASET, batches } from '../lib/sources/databento.ts';
import { loadCandidateDays, nextDay } from '../lib/candidates.ts';

const OUT = 'data/db/minutes';
const DRY = process.argv.includes('--dry');

async function main() {
  const { byDate, total } = await loadCandidateDays();
  const dates = [...byDate.keys()].sort();
  console.log(`${total.toLocaleString()} candidate symbol-days across ${dates.length} sessions`);

  await mkdir(OUT, { recursive: true });
  const have = new Set((await readdir(OUT).catch(() => [])).map((f) => f.replace('.json', '')));
  const todo = dates.filter((d) => !have.has(d));
  console.log(`${have.size} already cached, ${todo.length} to fetch`);
  if (!todo.length) { console.log('Nothing to do.'); return; }

  let cost = 0;
  for (const d of todo.slice(0, 8)) {
    cost += await getCost({
      dataset: MINUTE_DATASET, symbols: byDate.get(d)!.map((s) => s.symbol).join(','),
      schema: 'ohlcv-1m', start: `${d}T00:00:00Z`, end: `${nextDay(d)}T00:00:00Z`,
    });
  }
  const est = (cost / Math.min(8, todo.length)) * todo.length;
  console.log(`estimated cost: $${est.toFixed(2)}`);
  if (DRY) { console.log('\n--dry: stopping before any billable pull.'); return; }

  let done = 0, bars = 0;
  for (const date of todo) {
    const syms = byDate.get(date)!.map((s) => s.symbol);
    const bySym: Record<string, number[][]> = {};
    try {
      for (const batch of batches(syms)) {
        for await (const b of streamBars({
          dataset: MINUTE_DATASET, symbols: batch, schema: 'ohlcv-1m',
          start: `${date}T00:00:00Z`, end: `${nextDay(date)}T00:00:00Z`,
        })) {
          // Array-of-arrays, not objects: ~13,000 sessions of named keys is
          // hundreds of MB of repeated field names on disk.
          (bySym[b.symbol] ??= []).push([b.ts, b.open, b.high, b.low, b.close, b.volume]);
          bars++;
        }
      }
    } catch (e) {
      console.warn(`\n  ${date}: ${(e as Error).message.slice(0, 100)}`);
      continue;
    }
    await writeFile(`${OUT}/${date}.json`, JSON.stringify(bySym));
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  ${done}/${todo.length} sessions, ${bars.toLocaleString()} bars   `);
  }
  console.log(`\nCached ${done} sessions (${bars.toLocaleString()} minute bars) into ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
