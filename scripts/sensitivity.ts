/**
 * How much of the result is the strategy, and how much is friction?
 * -> data/sensitivity.json
 *
 * Run:  node --experimental-strip-types scripts/sensitivity.ts
 *
 * "It loses money" is not a useful finding on its own. A setup can have a real
 * edge that transaction costs happen to exceed, or no edge at all — those call
 * for completely different responses, and the headline P&L cannot tell them
 * apart. So the same signals are replayed across a sweep of slippage
 * assumptions, with position sizing deliberately taken out of the picture.
 *
 * Capital is set high enough that no trade is constrained and ruin never stops
 * the run. That is NOT a claim about tradability — it isolates the per-trade
 * expectancy of the setup itself, which is the thing being measured.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { loadCandidateDays } from '../lib/candidates.ts';
import { simulateSession, type Minute } from '../lib/intraday.ts';
import { RULES } from '../lib/strategy.ts';
import { etMinutes } from '../lib/ettime.ts';

const MINUTES = 'data/db/minutes';
const BIG_EQUITY = 10_000_000;   // large enough that sizing never binds

const SWEEP = [
  { label: 'no costs at all (fantasy)', slip: 0,     comm: 0 },
  { label: 'half a cent slippage',      slip: 0.005, comm: 0.002 },
  { label: 'one cent slippage',         slip: 0.01,  comm: 0.002 },
  { label: 'two cents slippage',        slip: 0.02,  comm: 0.002 },
  { label: 'three cents slippage',      slip: 0.03,  comm: 0.002 },
];

function signalMinute(bars: Minute[], prevClose: number, avgVol50: number): number | null {
  let cum = 0;
  for (const b of bars) {
    cum += b.volume;
    if (etMinutes(b.ts) < 9 * 60 + 30) continue;
    if (((b.close - prevClose) / prevClose) * 100 >= 10 && cum >= avgVol50) return b.ts;
  }
  return null;
}

async function main() {
  const { byDate } = await loadCandidateDays();
  const files = (await readdir(MINUTES).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) { console.error('No minute cache.'); process.exit(1); }

  // Load every session once; the sweep replays the same setups.
  console.log(`Loading ${files.length} sessions…`);
  const sessions: { date: string; sym: string; bars: Minute[]; prevClose: number; avgVol50: number; rel: number }[] = [];
  for (const f of files) {
    const date = f.replace('.json', '');
    const signals = byDate.get(date);
    if (!signals) continue;
    const raw: Record<string, number[][]> = JSON.parse(await readFile(`${MINUTES}/${f}`, 'utf8'));
    const ranked = signals.map((s) => ({ s, rel: s.dayVolume / s.avgVol50 })).sort((a, b) => b.rel - a.rel);
    let taken = 0;
    for (const { s, rel } of ranked) {
      if (taken >= RULES.maxPositions) break;
      const rows = raw[s.symbol];
      if (!rows || rows.length < 20) continue;
      const bars: Minute[] = rows.map(([ts, o, h, l, c, v]) => ({ ts, open: o, high: h, low: l, close: c, volume: v }))
        .sort((a, b) => a.ts - b.ts);
      const fired = signalMinute(bars, s.prevClose, s.avgVol50);
      if (fired === null) continue;
      sessions.push({ date, sym: s.symbol, bars: bars.filter((b) => b.ts >= fired), prevClose: s.prevClose, avgVol50: s.avgVol50, rel });
      taken++;
    }
  }
  console.log(`  ${sessions.length} tradable setups\n`);

  const results = [];
  console.log(`${'assumption'.padEnd(30)}${'trades'.padStart(8)}${'win%'.padStart(8)}${'avg win'.padStart(10)}${'avg loss'.padStart(10)}${'expectancy'.padStart(12)}`);
  console.log('-'.repeat(78));
  for (const cfg of SWEEP) {
    const pnls: number[] = [];
    for (const s of sessions) {
      const t = simulateSession(s.sym, s.date, s.bars, RULES.riskPerTrade, BIG_EQUITY,
        { slippagePerShare: cfg.slip, commissionPerShare: cfg.comm });
      if (t) pnls.push(t.pnl);
    }
    const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p <= 0);
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const exp = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    results.push({ ...cfg, trades: pnls.length, winRate: wins.length / pnls.length * 100, avgWin, avgLoss, expectancy: exp, total: pnls.reduce((a,b)=>a+b,0) });
    console.log(
      cfg.label.padEnd(30) +
      String(pnls.length).padStart(8) +
      (wins.length / pnls.length * 100).toFixed(1).padStart(7) + '%' +
      ('$' + avgWin.toFixed(2)).padStart(10) +
      ('$' + avgLoss.toFixed(2)).padStart(10) +
      ('$' + exp.toFixed(2)).padStart(12),
    );
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/sensitivity.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Position sizing removed (unlimited capital) to isolate per-trade expectancy.',
    riskPerTrade: RULES.riskPerTrade, setups: sessions.length, results,
  }, null, 2));
  console.log('\nExpectancy is dollars per trade on $' + RULES.riskPerTrade + ' of risk.');
  console.log('Wrote data/sensitivity.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
