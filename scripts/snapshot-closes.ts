/**
 * Record the session's closing prices -> data/prevclose.json
 *
 * Run after the close (the workflow does it at 21:10 UTC).
 *
 * The pre-market scan needs yesterday's close to measure this morning's move.
 * Deriving it from a vendor's own "percent change" field is fragile — you
 * cannot tell whether that field has rolled over to the new session or is still
 * reporting yesterday. Storing the close ourselves removes the guess, and lets
 * the scan detect a stale feed instead of silently reporting no movement.
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { getUniverse } from '../lib/sources/nasdaq.ts';

const { quotes, asOf } = await getUniverse();
const out: Record<string, number> = {};
for (const q of quotes) if (q.price > 0) out[q.symbol] = q.price;

await mkdir('data', { recursive: true });
await writeFile('data/prevclose.json', JSON.stringify(out));

/**
 * Keep a short rolling window of closes as well.
 *
 * A stock up 100% in one session on fresh news is the setup; a stock up 100%
 * across three sessions is the thing to avoid — the sources are explicit that
 * a day-three runner is usually a squeeze to leave alone. Telling those apart
 * needs more than yesterday's close, so we keep the last six.
 */
const KEEP = 6;
let history: Record<string, number[]> = {};
try { history = JSON.parse(await readFile('data/closes.json', 'utf8')); } catch { /* first run */ }

const session = asOf ?? new Date().toISOString().slice(0, 10);
let meta: Record<string, string> = {};
try { meta = JSON.parse(await readFile('data/closes.meta.json', 'utf8')); } catch { /* first run */ }

// Guard against appending the same session twice — the workflow can be run by
// hand, and a duplicated close would fake a flat day and hide a real run.
if (meta.lastSession === session) {
  console.log(`Session ${session} already recorded — not appending again`);
} else {
  for (const [sym, px] of Object.entries(out)) {
    const arr = history[sym] ?? [];
    arr.push(px);
    history[sym] = arr.slice(-KEEP);
  }
  await writeFile('data/closes.json', JSON.stringify(history));
  await writeFile('data/closes.meta.json', JSON.stringify({ lastSession: session }));
}

console.log(`Wrote data/prevclose.json — ${Object.keys(out).length} closes, session ${session}`);
console.log(`Rolling history: ${Object.keys(history).length} symbols, up to ${KEEP} sessions each`);
