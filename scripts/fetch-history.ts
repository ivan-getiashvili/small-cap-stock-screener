/**
 * Cache daily bars for the small-cap universe -> data/history/<SYM>.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-history.ts
 *
 * The backtest needs to know what EVERY small cap did on every past day, not
 * just today's candidates. That is one request per symbol, so we do it once
 * and cache. The script is resumable: symbols already on disk and fresh enough
 * are skipped, so an interrupted run costs nothing to restart.
 */
import { writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { getUniverse, getBars } from '../lib/sources/nasdaq.ts';

const DIR = 'data/history';
const MAX_AGE_HOURS = 12;
const CONCURRENCY = 6;
/** Only names that could ever be candidates — keeps this from being 6,000 calls. */
const UNIVERSE = { priceMin: 0.5, priceMax: 30, maxMarketCap: 3e9 };

async function isFresh(sym: string): Promise<boolean> {
  try {
    const s = await stat(`${DIR}/${sym}.json`);
    return (Date.now() - s.mtimeMs) / 3_600_000 < MAX_AGE_HOURS;
  } catch { return false; }
}

const argLimit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0');

async function main() {
  await mkdir(DIR, { recursive: true });
  const { quotes } = await getUniverse();

  let syms = quotes
    .filter((q) => q.price >= UNIVERSE.priceMin && q.price <= UNIVERSE.priceMax &&
                   (q.marketCap === null || q.marketCap <= UNIVERSE.maxMarketCap))
    .map((q) => q.symbol);
  if (argLimit > 0) syms = syms.slice(0, argLimit);

  const existing = new Set(await readdir(DIR).catch(() => []));
  console.log(`${syms.length} small caps in scope; ${existing.size} already cached`);

  const todo: string[] = [];
  for (const s of syms) if (!(await isFresh(s))) todo.push(s);
  console.log(`fetching ${todo.length}…`);

  let done = 0, failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = next++;
        if (i >= todo.length) return;
        const sym = todo[i];
        try {
          const bars = await getBars(sym, 550);
          if (bars.length >= 30) await writeFile(`${DIR}/${sym}.json`, JSON.stringify(bars));
        } catch { failed++; }
        done++;
        if (done % 25 === 0) process.stdout.write(`\r  ${done}/${todo.length} (${failed} failed)   `);
      }
    }),
  );
  console.log(`\nCached ${done - failed} symbols into ${DIR}/ (${failed} failed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
