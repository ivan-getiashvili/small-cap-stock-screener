/**
 * A forward-running paper account -> data/paper.json
 *
 * Run:  npm run paper     (after the close, once data/screen.json exists)
 *
 * Why this exists alongside the backtest: a backtest is fitted to history you
 * already know, and every knob you turn leaks hindsight into it. This does not.
 * It takes whatever the screener printed that evening, commits to those names
 * before the next session, and scores itself afterwards with no chance to
 * revise. It starts empty and earns its track record in real time — slowly, but
 * it is the only number here that cannot be talked up.
 *
 * Flow, deliberately one session behind:
 *   evening of D   — read the shortlist, queue the top N for entry at D+1 open
 *   evening of D+1 — resolve those queued trades against D+1's actual bar
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getBars } from '../lib/sources/nasdaq.ts';
import { simulateDay, summarise, RULES, type Trade } from '../lib/strategy.ts';

type Pending = { symbol: string; queuedOn: string; sykes: number; relVolume: number | null; price: number };
type State = {
  startedAt: string;
  startingCash: number;
  cash: number;
  pending: Pending[];
  trades: Trade[];
  log: { date: string; note: string }[];
};

const FILE = 'data/paper.json';

async function load(): Promise<State> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return {
      startedAt: new Date().toISOString(),
      startingCash: RULES.startingCash,
      cash: RULES.startingCash,
      pending: [],
      trades: [],
      log: [],
    };
  }
}

async function main() {
  const state = await load();
  const screen = JSON.parse(await readFile('data/screen.json', 'utf8'));
  const asOf: string = screen.asOf;

  // ---- 1. Resolve anything queued on an earlier session -------------------
  const stillPending: Pending[] = [];
  for (const p of state.pending) {
    if (p.queuedOn >= asOf) { stillPending.push(p); continue; }  // not traded yet

    const bars = await getBars(p.symbol, 30).catch(() => []);
    // The session immediately after the one that produced the signal.
    const bar = bars.find((b) => b.date > p.queuedOn);
    if (!bar) { stillPending.push(p); continue; }                // market hasn't opened yet

    const t = simulateDay(p.symbol, bar);
    if (t) {
      state.trades.push(t);
      state.cash += t.pnl;
      state.log.push({
        date: bar.date,
        note: `${t.symbol} ${t.exitReason} @ $${t.exit.toFixed(2)} from $${t.entry.toFixed(2)} × ${t.shares} = ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`,
      });
    }
  }
  state.pending = stillPending;

  // ---- 2. Queue tonight's picks ------------------------------------------
  const already = new Set(state.pending.map((p) => p.symbol));
  const picks = (screen.rows as any[])
    .filter((r) => r.cameron.passed)
    .sort((a, b) => b.sykes.total - a.sykes.total)
    .filter((r) => !already.has(r.quote.symbol))
    .slice(0, RULES.maxPositions);

  for (const r of picks) {
    state.pending.push({
      symbol: r.quote.symbol,
      queuedOn: asOf,
      sykes: r.sykes.total,
      relVolume: r.relVolume,
      price: r.quote.price,
    });
  }
  if (picks.length) {
    state.log.push({ date: asOf, note: `queued ${picks.map((p) => p.quote.symbol).join(', ')} for next open` });
  } else {
    state.log.push({ date: asOf, note: 'no name passed all five pillars — no position taken' });
  }

  const stats = summarise(state.trades, state.startingCash);
  await mkdir('data', { recursive: true });
  await writeFile(FILE, JSON.stringify({ ...state, stats }, null, 2));

  console.log(`Paper account — started ${state.startedAt.slice(0, 10)}`);
  console.log(`  closed trades   ${stats.trades}`);
  if (stats.trades) {
    console.log(`  accuracy        ${stats.accuracy.toFixed(1)}%  (target/stop/close ${stats.byReason.target}/${stats.byReason.stop}/${stats.byReason.close})`);
    console.log(`  equity          $${state.startingCash} → $${stats.endingEquity.toFixed(2)}  (${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct.toFixed(1)}%)`);
    console.log(`  max drawdown    ${stats.maxDrawdownPct.toFixed(1)}%`);
  }
  console.log(`  queued for next open: ${state.pending.map((p) => p.symbol).join(', ') || '(none)'}`);
  for (const l of state.log.slice(-5)) console.log(`   · ${l.date}  ${l.note}`);
  console.log(`\nWrote ${FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
