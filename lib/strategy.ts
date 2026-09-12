/**
 * Cameron's trade management, expressed so it can run over daily bars.
 *
 * His actual rules, from warriortrading.com/momentum-day-trading-strategy:
 *   - stop just below the first pullback; if that is more than 20c away, use 20c
 *   - "I always want to trade with a 2:1 profit loss ratio" — 20c risk, 40c target
 *   - position size = max risk / stop distance ($500 / $0.20 = 2,500 shares)
 *   - he does not hold overnight
 *
 * The honest limitation: he enters on an intraday pullback that daily bars
 * cannot see. We enter at the open instead. That is a DIFFERENT and worse
 * entry than his — it takes the gap against us — so results here should be
 * read as a floor on the setup's edge, not as a reproduction of his returns.
 */
import type { Bar } from './types.ts';

export const RULES = {
  stopPct: 0.04,        // ~20c on a $5 stock, his stated stop distance
  rewardRatio: 2,       // his stated 2:1
  riskPerTrade: 100,    // dollars risked per position
  maxPositions: 3,      // Sykes: "one, two, three, four, or five" names, not 20
  startingCash: 2000,   // matches the size of account he demos
} as const;

export type Trade = {
  symbol: string;
  date: string;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  exit: number;
  exitReason: 'stop' | 'target' | 'close';
  pnl: number;
  returnPct: number;
};

/**
 * Run one day's bar through the rules.
 *
 * When a bar's high hits the target AND its low hits the stop, daily data
 * cannot say which came first. We always assume the stop — the pessimistic
 * reading. Assuming the target instead is the single easiest way to make a
 * momentum backtest look profitable when it is not.
 */
export function simulateDay(symbol: string, bar: Bar, riskDollars = RULES.riskPerTrade): Trade | null {
  const entry = bar.open;
  if (!(entry > 0)) return null;

  const stop = entry * (1 - RULES.stopPct);
  const target = entry + (entry - stop) * RULES.rewardRatio;
  const shares = Math.max(1, Math.floor(riskDollars / (entry - stop)));

  let exit = bar.close;
  let exitReason: Trade['exitReason'] = 'close';
  if (bar.low <= stop) { exit = stop; exitReason = 'stop'; }
  else if (bar.high >= target) { exit = target; exitReason = 'target'; }

  const pnl = (exit - entry) * shares;
  return {
    symbol, date: bar.date, entry, stop, target, shares, exit, exitReason,
    pnl, returnPct: ((exit - entry) / entry) * 100,
  };
}

/** Summary statistics for a set of trades. */
export function summarise(trades: Trade[], startingCash = RULES.startingCash) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gross = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;

  // Equity curve and worst peak-to-trough drawdown, in order.
  let equity = startingCash, peak = startingCash, maxDD = 0;
  const curve: { date: string; equity: number }[] = [];
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak > 0 ? (peak - equity) / peak : 0);
    curve.push({ date: t.date, equity });
  }

  return {
    trades: trades.length,
    wins: wins.length,
    accuracy: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossPnl: gross,
    avgWin, avgLoss,
    profitLossRatio: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null,
    endingEquity: equity,
    returnPct: ((equity - startingCash) / startingCash) * 100,
    maxDrawdownPct: maxDD * 100,
    byReason: {
      target: trades.filter((t) => t.exitReason === 'target').length,
      stop: trades.filter((t) => t.exitReason === 'stop').length,
      close: trades.filter((t) => t.exitReason === 'close').length,
    },
    curve,
  };
}
