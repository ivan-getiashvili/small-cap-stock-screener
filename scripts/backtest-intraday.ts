/**
 * Minute-resolution backtest over cached bars -> data/backtest-intraday.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-db-universe.ts   (once)
 *       node --experimental-strip-types scripts/fetch-db-minutes.ts    (once)
 *       npm run backtest:intraday                                      (free, repeatable)
 *
 * Reads only from disk, so the trading rules can be changed and re-tested
 * without re-buying data. Day selection lives in lib/candidates.ts; the trade
 * logic lives in lib/intraday.ts.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { loadCandidateDays, SELECT } from '../lib/candidates.ts';
import { simulateSession, type Minute, type IntradayTrade, INTRADAY } from '../lib/intraday.ts';
import { RULES, summarise } from '../lib/strategy.ts';
import { etMinutes } from '../lib/ettime.ts';

const MINUTES = 'data/db/minutes';

/** First minute a live scanner could have flagged this — causal, no hindsight. */
function signalMinute(bars: Minute[], prevClose: number, avgVol50: number): number | null {
  let cum = 0;
  for (const b of bars) {
    cum += b.volume;
    if (etMinutes(b.ts) < 9 * 60 + 30) continue;
    const chg = ((b.close - prevClose) / prevClose) * 100;
    if (chg >= 10 && cum >= avgVol50) return b.ts;
  }
  return null;
}

async function main() {
  const { byDate } = await loadCandidateDays();
  const cached = (await readdir(MINUTES).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  if (!cached.length) { console.error(`No minute cache in ${MINUTES}/. Run fetch-db-minutes.ts first.`); process.exit(1); }
  console.log(`Simulating ${cached.length} cached sessions…`);

  const trades: IntradayTrade[] = [];
  let noSignal = 0, noSetup = 0, noData = 0, ambiguous = 0;
  let equity = RULES.startingCash;
  let ruinedOn: string | null = null;

  for (const file of cached) {
    const date = file.replace('.json', '');
    const signals = byDate.get(date);
    if (!signals) continue;
    if (equity <= 0) { ruinedOn ??= date; break; }   // a blown account stops trading

    const raw: Record<string, number[][]> = JSON.parse(await readFile(`${MINUTES}/${file}`, 'utf8'));

    const ranked = signals
      .map((s) => ({ s, rel: s.dayVolume / s.avgVol50 }))
      .sort((a, b) => b.rel - a.rel);

    let taken = 0;
    for (const { s } of ranked) {
      if (taken >= RULES.maxPositions || equity <= 0) break;
      const rows = raw[s.symbol];
      if (!rows || rows.length < 20) { noData++; continue; }
      const bars: Minute[] = rows
        .map(([ts, o, h, l, c, v]) => ({ ts, open: o, high: h, low: l, close: c, volume: v }))
        .sort((a, b) => a.ts - b.ts);

      const fired = signalMinute(bars, s.prevClose, s.avgVol50);
      if (fired === null) { noSignal++; continue; }

      // Risk a fixed FRACTION of equity, not a fixed dollar amount. $100 on a
      // $2,000 account is 5% a trade, well outside Sykes' stated 1-3% band, and
      // it makes ruin a property of the sizing rather than of the strategy.
      const t = simulateSession(
        s.symbol, date, bars.filter((b) => b.ts >= fired),
        Math.max(1, equity * RULES.riskPct),
        equity,
      );
      if (!t) { noSetup++; continue; }
      if (t.ambiguous) ambiguous++;
      trades.push(t); equity += t.pnl; taken++;
    }
  }
  if (equity <= 0 && !ruinedOn) ruinedOn = trades.at(-1)?.date ?? null;

  const stats = summarise(trades as any, RULES.startingCash);
  const held = trades.map((t) => t.heldMinutes).sort((a, b) => a - b);
  const rets = trades.map((t) => t.returnPct);
  const payload = {
    generatedAt: new Date().toISOString(),
    resolution: '1-minute',
    survivorshipFree: true,
    window: { from: cached[0].replace('.json',''), to: cached.at(-1)!.replace('.json','') },
    daysPulled: cached.length,
    candidateSymbolDays: [...byDate.values()].reduce((a, b) => a + b.length, 0),
    rules: { ...RULES, ...INTRADAY },
    selection: SELECT,
    ruinedOn,
    diagnostics: { noSignal, noSetup, noData, ambiguous, ambiguousPct: trades.length ? (ambiguous / trades.length) * 100 : 0 },
    medianHoldMinutes: held.length ? held[Math.floor(held.length / 2)] : null,
    meanReturnPct: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    byExitReason: trades.reduce((a, t) => { a[t.exitReason] = (a[t.exitReason] ?? 0) + 1; return a; }, {} as Record<string, number>),
    stats,
    trades: trades.slice(0, 400),
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/backtest-intraday.json', JSON.stringify(payload, null, 2));

  console.log(`\n  Window          ${payload.window.from} → ${payload.window.to}`);
  console.log(`  Trades          ${trades.length}   (no signal ${noSignal}, no setup ${noSetup}, no data ${noData})`);
  console.log(`  Accuracy        ${stats.accuracy.toFixed(1)}%`);
  console.log(`  Avg win / loss  $${stats.avgWin.toFixed(2)} / $${stats.avgLoss.toFixed(2)}   ratio ${stats.profitLossRatio?.toFixed(2) ?? '—'}`);
  console.log(`  Mean return     ${payload.meanReturnPct.toFixed(2)}% per trade`);
  console.log(`  Equity          $${RULES.startingCash} → $${stats.endingEquity.toFixed(2)}  (${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct.toFixed(1)}%)`);
  console.log(`  Max drawdown    ${stats.maxDrawdownPct.toFixed(1)}%`);
  if (ruinedOn) console.log(`  ACCOUNT BLOWN   ${ruinedOn}`);
  console.log(`  Median hold     ${payload.medianHoldMinutes} min`);
  console.log(`  Exits           ${JSON.stringify(payload.byExitReason)}`);
  console.log(`  Ambiguous       ${ambiguous} (${payload.diagnostics.ambiguousPct.toFixed(1)}%, resolved against us)`);
  console.log('\nWrote data/backtest-intraday.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
