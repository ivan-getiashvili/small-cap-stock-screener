/**
 * Build a survivorship-free daily history -> data/db/daily/<SYM>.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-db-universe.ts [--dry]
 *
 * The universe is assembled from Databento instrument DEFINITIONS sampled
 * across the whole period, not from today's listings. That distinction is the
 * entire point: a universe built from what is listed today silently deletes
 * every company that collapsed and delisted, and for small caps those are most
 * of the losers. Backtests built that way look far better than reality.
 *
 * Verified before building this: 37 of 40 probed delisted tickers still return
 * bars, so the data genuinely survives the delisting.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { listSymbolsOn, streamBars, getCost, batches, DAILY_DATASET } from '../lib/sources/databento.ts';

const OUT = 'data/db/daily';
/** Dates sampled to catch listings that appeared or vanished mid-period. */
const SAMPLE_DATES = ['2024-07-02', '2025-01-02', '2025-07-01', '2026-01-02', '2026-06-01', '2026-09-10'];
const START = '2024-07-01T00:00:00Z';
const END = '2026-09-12T00:00:00Z';
const DRY = process.argv.includes('--dry');

async function main() {
  console.log('Assembling the historical universe (including delisted names)…');
  const all = new Set<string>();
  for (const d of SAMPLE_DATES) {
    try {
      const syms = await listSymbolsOn(d);
      syms.forEach((s) => all.add(s));
      console.log(`  ${d}: ${syms.length} symbols defined  (running union ${all.size})`);
    } catch (e) {
      console.warn(`  ${d}: failed — ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const symbols = [...all].sort();
  console.log(`\nUniverse: ${symbols.length} symbols across the period`);

  const groups = batches(symbols);
  let total = 0;
  for (const g of groups) {
    total += await getCost({
      dataset: DAILY_DATASET, symbols: g.join(','), schema: 'ohlcv-1d', start: START, end: END,
    });
  }
  console.log(`Cost for daily bars over the full range: $${total.toFixed(2)}  (${groups.length} batches)`);
  if (DRY) { console.log('\n--dry: stopping before any billable pull.'); return; }

  await mkdir(OUT, { recursive: true });
  let rows = 0, written = 0;

  // Flush after each batch. Holding all ~8M bars in memory before writing
  // needs the better part of a gigabyte and dies partway through; a batch is
  // a disjoint set of symbols, so it can be written and dropped immediately.
  for (const [i, g] of groups.entries()) {
    const bySymbol = new Map<string, any[]>();
    for await (const b of streamBars({
      dataset: DAILY_DATASET, symbols: g, schema: 'ohlcv-1d', start: START, end: END,
    })) {
      if (!(b.close > 0) || !(b.volume >= 0)) continue;
      const date = new Date(b.ts).toISOString().slice(0, 10);
      if (!bySymbol.has(b.symbol)) bySymbol.set(b.symbol, []);
      bySymbol.get(b.symbol)!.push({
        date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
      });
      rows++;
    }
    for (const [sym, bars] of bySymbol) {
      if (bars.length < 60) continue;            // too short for a 50-day average
      bars.sort((a, b) => a.date.localeCompare(b.date));
      await writeFile(`${OUT}/${sym}.json`, JSON.stringify(bars));
      written++;
    }
    console.log(`  batch ${i + 1}/${groups.length}: ${rows.toLocaleString()} bars so far, ${written} symbols written`);
  }
  console.log(`\nWrote ${written} symbols to ${OUT}/ (${rows.toLocaleString()} daily bars)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
