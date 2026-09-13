/**
 * Backtest the mechanical pillars over cached history -> data/backtest.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-history.ts   (once)
 *       npm run backtest
 *
 * WHAT THIS TESTS, precisely — the claim being measured is narrow on purpose:
 *
 *   "A stock that closed up >=10% on >=5x relative volume, priced $2-$20,
 *    with a float under the threshold — how did it trade the NEXT session?"
 *
 * That is the setup this screener actually hands you after the close, so it is
 * the one worth measuring. Entry is next open, managed by the momentum source's stop and
 * 2:1 target.
 *
 * WHAT IT CANNOT TEST, and why the numbers are not his numbers:
 *
 *   1. SURVIVORSHIP. The universe is what is listed TODAY. Small caps that
 *      collapsed and delisted are absent, and those are exactly the losers.
 *      This biases results optimistic, and there is no free fix.
 *   2. NO CATALYST FILTER. Historical per-day news is not available free, so
 *      the news pillar — which both methodologies call decisive — is simply not applied.
 *   3. FLOAT IS TODAY'S. Applied backwards to every historical day. After a
 *      reverse split or raise that is wrong, so float is left OUT of the
 *      historical filter rather than applied incorrectly.
 *   4. DAILY BARS, NOT INTRADAY. the momentum source holds minutes and enters on a
 *      pullback; we enter at the open and exit by the close.
 *
 * So: this measures whether the volume-and-momentum core has an edge, with the
 * catalyst judgement stripped out. Read it as a floor, and as a sanity check on
 * the filter — not as a forecast of returns.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { CRITERIA } from '../lib/screen.ts';
import { simulateDay, summarise, RULES, type Trade } from '../lib/strategy.ts';
import { VARIANTS } from '../lib/variants.ts';
import type { Bar } from '../lib/types.ts';

const DIR = 'data/history';

type Signal = { symbol: string; signalDate: string; changePct: number; relVolume: number; price: number };

function findSignals(symbol: string, bars: Bar[]): { signal: Signal; nextBar: Bar }[] {
  const out: { signal: Signal; nextBar: Bar }[] = [];
  const c = CRITERIA.gate;

  for (let i = 51; i < bars.length - 1; i++) {
    const day = bars[i], prev = bars[i - 1], next = bars[i + 1];
    if (!(prev.close > 0)) continue;

    const changePct = ((day.close - prev.close) / prev.close) * 100;
    if (changePct < c.minChangePct) continue;
    if (day.close < c.priceMin || day.close > c.priceMax) continue;

    const window = bars.slice(i - 50, i);
    const avg = window.reduce((a, b) => a + b.volume, 0) / window.length;
    if (!(avg > 0)) continue;
    const relVolume = day.volume / avg;
    if (relVolume < c.minRelVolume) continue;

    // Liquidity floor — a fill is fiction without it.
    if (day.close * day.volume < 1_000_000) continue;

    out.push({
      signal: { symbol, signalDate: day.date, changePct, relVolume, price: day.close },
      nextBar: next,
    });
  }
  return out;
}

async function main() {
  const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.error(`No cached history in ${DIR}/. Run scripts/fetch-history.ts first.`);
    process.exit(1);
  }
  console.log(`Reading ${files.length} cached symbols…`);

  const all: { signal: Signal; nextBar: Bar }[] = [];
  for (const f of files) {
    try {
      const bars: Bar[] = JSON.parse(await readFile(`${DIR}/${f}`, 'utf8'));
      if (bars.length > 60) all.push(...findSignals(f.replace('.json', ''), bars));
    } catch { /* a corrupt cache entry should not stop the run */ }
  }
  all.sort((a, b) => a.signal.signalDate.localeCompare(b.signal.signalDate));
  console.log(`  ${all.length} historical signals found`);
  if (!all.length) { console.log('Nothing to test.'); return; }

  // Cap positions per day the way the scoring source does — the shortlist is short. Without
  // this, the backtest quietly assumes infinite capital on the busiest days.
  const byDay = new Map<string, typeof all>();
  for (const s of all) {
    const k = s.signal.signalDate;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(s);
  }

  const trades: Trade[] = [];
  const taken: Signal[] = [];
  let equity = RULES.startingCash;
  let ruinedOn: string | null = null;

  for (const [date, day] of [...byDay.entries()].sort()) {
    if (equity <= 0) { ruinedOn ??= date; break; }   // a blown account stops trading
    // Rank by relative volume: the pillar both methodologies weight most heavily.
    const picks = day.sort((a, b) => b.signal.relVolume - a.signal.relVolume).slice(0, RULES.maxPositions);
    for (const p of picks) {
      if (equity <= 0) break;
      // Never risk more than the account still has.
      const risk = Math.min(RULES.riskPerTrade, equity);
      const t = simulateDay(p.signal.symbol, p.nextBar, risk);
      if (t) { trades.push(t); taken.push(p.signal); equity += t.pnl; }
    }
  }
  if (equity <= 0 && !ruinedOn) ruinedOn = trades.at(-1)?.date ?? null;

  const stats = summarise(trades);
  const first = all[0].signal.signalDate, last = all.at(-1)!.signal.signalDate;

  // What did the setup do regardless of our trade management? This separates
  // "the signal is worthless" from "our exit rules are wrong".
  const rawNextDay = all.map((s) => ((s.nextBar.close - s.nextBar.open) / s.nextBar.open) * 100);
  const rawHigh = all.map((s) => ((s.nextBar.high - s.nextBar.open) / s.nextBar.open) * 100);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // Same signals, several exit rules. This is what separates "the signal is
  // worthless" from "this particular stop is wrong".
  const variants = VARIANTS.map((v) => {
    const results = all.map((s) => v.run(s.nextBar, s.signal.price)).filter((r) => r !== null);
    const rets = results.map((r) => r!.pnlPct);
    const wins = rets.filter((r) => r > 0).length;
    const ambiguous = results.filter((r) => r!.ambiguous).length;
    // Compounding at a fixed 10% of equity per trade, in date order.
    let eq = 1;
    for (const r of rets) eq *= 1 + (r! / 100) * 0.10;
    return {
      key: v.key, label: v.label, note: v.note,
      trades: rets.length,
      winRatePct: (wins / rets.length) * 100,
      meanPct: rets.reduce((a, b) => a + b, 0) / rets.length,
      medianPct: [...rets].sort((a, b) => a - b)[Math.floor(rets.length / 2)],
      totalIfCompounded10Pct: (eq - 1) * 100,
      ambiguousBars: ambiguous,
      ambiguousPct: (ambiguous / rets.length) * 100,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    variants,
    window: { from: first, to: last },
    symbolsTested: files.length,
    signals: all.length,
    tradesTaken: trades.length,
    ruinedOn,
    rules: RULES,
    criteria: CRITERIA.gate,
    stats,
    setupBehaviour: {
      meanOpenToClosePct: mean(rawNextDay),
      medianOpenToClosePct: median(rawNextDay),
      meanOpenToHighPct: mean(rawHigh),
      medianOpenToHighPct: median(rawHigh),
      pctOfDaysGreen: (rawNextDay.filter((x) => x > 0).length / rawNextDay.length) * 100,
    },
    caveats: [
      'Survivorship bias: universe is stocks listed today; delisted losers are absent.',
      'No catalyst filter — historical per-day news is not available free.',
      'Float excluded from the historical filter; today\'s float cannot be applied backwards.',
      'Daily bars only. Entry at next open, not on an intraday pullback.',
      'When a bar hits both stop and target, the stop is always assumed to hit first.',
    ],
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/backtest.json', JSON.stringify(payload, null, 2));

  const s = stats, b = payload.setupBehaviour;
  console.log(`\n  Window            ${first} → ${last}`);
  console.log(`  Signals           ${all.length}  (${trades.length} traded, max ${RULES.maxPositions}/day)`);
  console.log(`  Accuracy          ${s.accuracy.toFixed(1)}%   target/stop/close: ${s.byReason.target}/${s.byReason.stop}/${s.byReason.close}`);
  console.log(`  Avg win / loss    $${s.avgWin.toFixed(2)} / $${s.avgLoss.toFixed(2)}   ratio ${s.profitLossRatio?.toFixed(2) ?? '—'}`);
  console.log(`  Gross P&L         $${s.grossPnl.toFixed(2)} on $${RULES.riskPerTrade} risk/trade`);
  console.log(`  Equity            $${RULES.startingCash} → $${s.endingEquity.toFixed(2)}  (${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%)`);
  console.log(`  Max drawdown      ${s.maxDrawdownPct.toFixed(1)}%`);
  if (payload.ruinedOn) console.log(`  ACCOUNT BLOWN     ${payload.ruinedOn} — trading stopped there`);
  console.log(`\n  Setup behaviour, ignoring our exit rules:`);
  console.log(`    next-day open→close   mean ${b.meanOpenToClosePct.toFixed(2)}%  median ${b.medianOpenToClosePct.toFixed(2)}%`);
  console.log(`    next-day open→high    mean ${b.meanOpenToHighPct.toFixed(2)}%  median ${b.medianOpenToHighPct.toFixed(2)}%`);
  console.log(`    green days            ${b.pctOfDaysGreen.toFixed(1)}%`);
  console.log(`\n  Exit rules compared over the same ${all.length} signals:`);
  console.log('    ' + 'rule'.padEnd(34) + 'win%'.padStart(7) + 'mean'.padStart(9) + 'median'.padStart(9) + 'ambig'.padStart(8));
  for (const v of variants) {
    console.log('    ' + v.label.padEnd(34) +
      (v.winRatePct.toFixed(1) + '%').padStart(7) +
      (v.meanPct.toFixed(2) + '%').padStart(9) +
      (v.medianPct.toFixed(2) + '%').padStart(9) +
      (v.ambiguousPct > 0 ? v.ambiguousPct.toFixed(0) + '%' : '—').padStart(8));
  }
  console.log('\nWrote data/backtest.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
