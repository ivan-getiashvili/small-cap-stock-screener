/**
 * Score every recorded shortlist name whose session has closed -> data/history.json
 *
 * Run:  npm run history:fill     (CI runs it after the close, and each morning)
 */
import { getBars } from '../lib/sources/nasdaq.ts';
import { loadHistory, saveHistory, fillPerformance } from '../lib/history.ts';

const h = await loadHistory();
const before = Object.values(h.days).flatMap((d) => d.names).filter((n) => !n.performance).length;
const filled = await fillPerformance(h, getBars);
await saveHistory(h);
console.log(`History: filled ${filled} of ${before} unscored names across ${Object.keys(h.days).length} days`);
