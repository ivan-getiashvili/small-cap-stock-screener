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
import { writeFile, mkdir } from 'node:fs/promises';
import { getUniverse } from '../lib/sources/nasdaq.ts';

const { quotes, asOf } = await getUniverse();
const out: Record<string, number> = {};
for (const q of quotes) if (q.price > 0) out[q.symbol] = q.price;

await mkdir('data', { recursive: true });
await writeFile('data/prevclose.json', JSON.stringify(out));
console.log(`Wrote data/prevclose.json — ${Object.keys(out).length} closes, session ${asOf ?? 'unknown'}`);
