/**
 * How much capital does this strategy actually need? -> data/capital.json
 *
 * Run:  node --experimental-strip-types scripts/capital-sweep.ts
 *
 * The sensitivity sweep found positive expectancy at 1c slippage, yet a $2,000
 * account still went to zero at those same settings. That is not a
 * contradiction, it is the most important result here: expectancy is measured
 * per trade with unlimited capital, and a small account cannot take the trades
 * that carry the edge.
 *
 * The setups with the tightest stops imply the largest share counts, and those
 * are precisely the ones a small account cannot hold inside 4x margin. So the
 * account is systematically filtered into the worse half of the distribution.
 * This sweep measures where that stops biting.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { loadCandidateDays } from '../lib/candidates.ts';
import { simulateSession, type Minute, INTRADAY } from '../lib/intraday.ts';
import { RULES, summarise } from '../lib/strategy.ts';
import { etMinutes } from '../lib/ettime.ts';

const MINUTES = 'data/db/minutes';
const CAPITALS = [2_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const SLIP = 0.01, COMM = 0.002;
/** Risk 2% of equity per trade — inside the scoring source's stated 1-3% band. */
const RISK_PCT = 0.02;

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
  console.log(`Loading ${files.length} sessions…`);

  const days: { date: string; setups: { sym: string; bars: Minute[] }[] }[] = [];
  for (const f of files) {
    const date = f.replace('.json', '');
    const signals = byDate.get(date);
    if (!signals) continue;
    const raw: Record<string, number[][]> = JSON.parse(await readFile(`${MINUTES}/${f}`, 'utf8'));
    const ranked = signals.map((s) => ({ s, rel: s.dayVolume / s.avgVol50 })).sort((a, b) => b.rel - a.rel);
    const setups: { sym: string; bars: Minute[] }[] = [];
    for (const { s } of ranked) {
      if (setups.length >= RULES.maxPositions) break;
      const rows = raw[s.symbol];
      if (!rows || rows.length < 20) continue;
      const bars: Minute[] = rows.map(([ts, o, h, l, c, v]) => ({ ts, open: o, high: h, low: l, close: c, volume: v }))
        .sort((a, b) => a.ts - b.ts);
      const fired = signalMinute(bars, s.prevClose, s.avgVol50);
      if (fired === null) continue;
      setups.push({ sym: s.symbol, bars: bars.filter((b) => b.ts >= fired) });
    }
    if (setups.length) days.push({ date, setups });
  }
  console.log(`  ${days.length} sessions with setups\n`);

  const results = [];
  console.log(`${'capital'.padStart(9)}${'trades'.padStart(8)}${'skipped'.padStart(9)}${'win%'.padStart(7)}${'end equity'.padStart(13)}${'return'.padStart(10)}${'maxDD'.padStart(8)}`);
  console.log('-'.repeat(64));
  for (const start of CAPITALS) {
    let equity = start;
    const trades: any[] = [];
    let skipped = 0, ruined = false;
    for (const d of days) {
      if (equity <= 0) { ruined = true; break; }
      for (const s of d.setups) {
        if (equity <= 0) break;
        const risk = Math.max(1, equity * RISK_PCT);
        const t = simulateSession(s.sym, d.date, s.bars, risk, equity, { slippagePerShare: SLIP, commissionPerShare: COMM });
        if (!t) { skipped++; continue; }
        trades.push(t); equity += t.pnl;
      }
    }
    const st = summarise(trades, start);
    results.push({ start, trades: trades.length, skipped, ruined, ...st, curve: undefined });
    console.log(
      ('$' + start.toLocaleString()).padStart(9) +
      String(trades.length).padStart(8) +
      String(skipped).padStart(9) +
      st.accuracy.toFixed(1).padStart(6) + '%' +
      ('$' + st.endingEquity.toFixed(0)).padStart(13) +
      ((st.returnPct >= 0 ? '+' : '') + st.returnPct.toFixed(0) + '%').padStart(10) +
      (st.maxDrawdownPct.toFixed(0) + '%').padStart(8),
    );
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/capital.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    slippagePerShare: SLIP, commissionPerShare: COMM, riskPct: RISK_PCT,
    leverage: INTRADAY.leverage, sessions: days.length, results,
  }, null, 2));
  console.log('\nRisk is ' + (RISK_PCT * 100) + '% of equity per trade, ' + (SLIP * 100) + 'c slippage each way.');
  console.log('Wrote data/capital.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
