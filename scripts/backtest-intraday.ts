/**
 * Minute-resolution backtest -> data/backtest-intraday.json
 *
 * Run:  node --experimental-strip-types scripts/fetch-db-universe.ts   (once)
 *       node --experimental-strip-types scripts/backtest-intraday.ts [--dry] [--days=N]
 *
 * HOW DAYS ARE SELECTED, and why it is done this way.
 *
 * We cannot afford minute bars for 15,000 symbols x 550 days, so daily bars
 * pick which symbol-days to buy. That selection is where a backtest is most
 * easily corrupted, so it is deliberately built to keep the losers in:
 *
 *   A day qualifies if its HIGH reached +10% over the prior close — NOT if it
 *   CLOSED up 10%.
 *
 * That distinction is the whole game. Selecting on the close would silently
 * drop every stock that spiked 12% at 10am and died at -5% by the bell — which
 * is precisely the losing trade this strategy needs to be measured against.
 * Selecting on the high keeps the fades in the sample.
 *
 * Remaining known bias, stated plainly: the volume screen uses the full day's
 * volume, which is not knowable at 10am. A stock reaching +10% intraday almost
 * always ends with elevated volume, so the effect is small — but it is not zero
 * and it points optimistic.
 *
 * The intraday signal itself is causal: it fires on the first minute where the
 * criteria are satisfied using only bars up to that minute.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { streamBars, getCost, MINUTE_DATASET, batches } from '../lib/sources/databento.ts';
import { simulateSession, type Minute, type IntradayTrade, INTRADAY } from '../lib/intraday.ts';
import { RULES, summarise } from '../lib/strategy.ts';
import { etMinutes as etMin } from '../lib/ettime.ts';

const DAILY = 'data/db/daily';
const DRY = process.argv.includes('--dry');
const DAY_LIMIT = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? '0');

const SELECT = {
  minIntradayHighPct: 10,   // Cameron's "up at least 10%", measured at the HIGH
  minVolumeMultiple: 3,     // generous: let the intraday logic do the real filtering
  priceMin: 2, priceMax: 20,
  minDollarVolume: 1_000_000,
};

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Signal = { symbol: string; date: string; prevClose: number; avgVol50: number; dayVolume: number };

function findCandidateDays(symbol: string, bars: Daily[]): Signal[] {
  const out: Signal[] = [];
  for (let i = 51; i < bars.length; i++) {
    const d = bars[i], prev = bars[i - 1];
    if (!(prev.close >= SELECT.priceMin && prev.close <= SELECT.priceMax)) continue;
    const highPct = ((d.high - prev.close) / prev.close) * 100;
    if (highPct < SELECT.minIntradayHighPct) continue;

    const window = bars.slice(i - 50, i);
    const avg = window.reduce((a, b) => a + b.volume, 0) / window.length;
    if (!(avg > 0) || d.volume < avg * SELECT.minVolumeMultiple) continue;
    if (d.close * d.volume < SELECT.minDollarVolume) continue;

    out.push({ symbol, date: d.date, prevClose: prev.close, avgVol50: avg, dayVolume: d.volume });
  }
  return out;
}

/** Group minute bars by symbol for one session. */
function group(rows: { symbol: string; ts: number; open: number; high: number; low: number; close: number; volume: number }[]) {
  const m = new Map<string, Minute[]>();
  for (const r of rows) {
    if (!m.has(r.symbol)) m.set(r.symbol, []);
    m.get(r.symbol)!.push({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  return m;
}



/**
 * The causal signal: the first minute at which a live scanner could have seen
 * this stock. Uses only bars up to that minute — no end-of-day knowledge.
 */
function signalMinute(bars: Minute[], prevClose: number, avgVol50: number): number | null {
  let cum = 0;
  for (const b of bars) {
    cum += b.volume;
    const m = etMin(b.ts);
    if (m < 9 * 60 + 30) continue;                     // regular session only
    const chg = ((b.close - prevClose) / prevClose) * 100;
    // Cameron: up >=10%, and volume already far beyond a normal full day —
    // his "5x relative volume", expressed with only what is known right now.
    if (chg >= 10 && cum >= avgVol50) return b.ts;
  }
  return null;
}

async function main() {
  const files = (await readdir(DAILY).catch(() => [])).filter((f) => f.endsWith('.json'));
  if (!files.length) { console.error(`No daily history in ${DAILY}/. Run fetch-db-universe.ts first.`); process.exit(1); }
  console.log(`Scanning ${files.length} symbols of survivorship-free daily history…`);

  const signals: Signal[] = [];
  for (const f of files) {
    try {
      const bars: Daily[] = JSON.parse(await readFile(`${DAILY}/${f}`, 'utf8'));
      signals.push(...findCandidateDays(f.replace('.json', ''), bars));
    } catch { /* skip a corrupt cache entry */ }
  }
  console.log(`  ${signals.length.toLocaleString()} candidate symbol-days`);

  const byDate = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  let dates = [...byDate.keys()].sort();
  if (DAY_LIMIT > 0) dates = dates.slice(-DAY_LIMIT);
  console.log(`  across ${dates.length} trading days`);

  // Price the pull before spending anything.
  let cost = 0;
  for (const d of dates.slice(0, 8)) {
    const syms = byDate.get(d)!.map((s) => s.symbol);
    cost += await getCost({
      dataset: MINUTE_DATASET, symbols: syms.join(','), schema: 'ohlcv-1m',
      start: `${d}T00:00:00Z`, end: `${next(d)}T00:00:00Z`,
    });
  }
  const est = (cost / Math.min(8, dates.length)) * dates.length;
  console.log(`  estimated minute-data cost: $${est.toFixed(2)}`);
  if (DRY) { console.log('\n--dry: stopping before any billable pull.'); return; }

  const trades: IntradayTrade[] = [];
  let noSignal = 0, noSetup = 0, pulled = 0, ambiguous = 0;

  for (const [i, date] of dates.entries()) {
    const daySignals = byDate.get(date)!;
    const rows: any[] = [];
    try {
      for (const batch of batches(daySignals.map((s) => s.symbol))) {
        for await (const b of streamBars({
          dataset: MINUTE_DATASET, symbols: batch, schema: 'ohlcv-1m',
          start: `${date}T00:00:00Z`, end: `${next(date)}T00:00:00Z`,
        })) rows.push(b);
      }
    } catch (e) {
      console.warn(`\n  ${date}: pull failed — ${(e as Error).message.slice(0, 100)}`);
      continue;
    }
    pulled++;
    const bySym = group(rows);

    // Rank the day's names the way the screener does, then take the top few —
    // no more positions than Cameron would actually hold at once.
    const ranked = daySignals
      .map((s) => ({ s, rel: s.dayVolume / s.avgVol50 }))
      .sort((a, b) => b.rel - a.rel);

    let taken = 0;
    for (const { s } of ranked) {
      if (taken >= RULES.maxPositions) break;
      const bars = bySym.get(s.symbol);
      if (!bars || bars.length < 20) continue;
      bars.sort((a, b) => a.ts - b.ts);

      const fired = signalMinute(bars, s.prevClose, s.avgVol50);
      if (fired === null) { noSignal++; continue; }

      // Only bars from the signal onward are tradable — anything earlier would
      // be acting on information the scanner did not yet have.
      const tradable = bars.filter((b) => b.ts >= fired);
      const t = simulateSession(s.symbol, date, tradable, RULES.riskPerTrade);
      if (!t) { noSetup++; continue; }
      if (t.ambiguous) ambiguous++;
      trades.push(t); taken++;
    }
    if (i % 20 === 0) process.stdout.write(`\r  ${i + 1}/${dates.length} days, ${trades.length} trades   `);
  }

  const stats = summarise(trades as any, RULES.startingCash);
  const held = trades.map((t) => t.heldMinutes).sort((a, b) => a - b);
  const payload = {
    generatedAt: new Date().toISOString(),
    resolution: '1-minute',
    dataset: MINUTE_DATASET,
    window: { from: dates[0], to: dates.at(-1) },
    survivorshipFree: true,
    daysPulled: pulled,
    candidateSymbolDays: signals.length,
    rules: { ...RULES, ...INTRADAY },
    selection: SELECT,
    diagnostics: { noSignal, noSetup, ambiguous, ambiguousPct: trades.length ? (ambiguous / trades.length) * 100 : 0 },
    medianHoldMinutes: held.length ? held[Math.floor(held.length / 2)] : null,
    byExitReason: trades.reduce((a, t) => { a[t.exitReason] = (a[t.exitReason] ?? 0) + 1; return a; }, {} as Record<string, number>),
    stats,
    trades: trades.slice(0, 500),
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/backtest-intraday.json', JSON.stringify(payload, null, 2));

  console.log(`\n\n  Window          ${dates[0]} → ${dates.at(-1)}  (${pulled} days pulled)`);
  console.log(`  Candidate days  ${signals.length.toLocaleString()}  |  trades taken ${trades.length}`);
  console.log(`  No signal fired ${noSignal}   no valid pullback setup ${noSetup}`);
  console.log(`  Accuracy        ${stats.accuracy.toFixed(1)}%`);
  console.log(`  Avg win / loss  $${stats.avgWin.toFixed(2)} / $${stats.avgLoss.toFixed(2)}   ratio ${stats.profitLossRatio?.toFixed(2) ?? '—'}`);
  console.log(`  Equity          $${RULES.startingCash} → $${stats.endingEquity.toFixed(2)}  (${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct.toFixed(1)}%)`);
  console.log(`  Max drawdown    ${stats.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Median hold     ${payload.medianHoldMinutes} min`);
  console.log(`  Exits           ${JSON.stringify(payload.byExitReason)}`);
  console.log(`  Ambiguous       ${ambiguous} (${payload.diagnostics.ambiguousPct.toFixed(1)}% — resolved against us)`);
  console.log('\nWrote data/backtest-intraday.json');
}

function next(d: string): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
}

main().catch((e) => { console.error(e); process.exit(1); });
