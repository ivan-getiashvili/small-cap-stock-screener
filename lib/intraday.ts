/**
 * the momentum source's actual strategy, simulated on 1-minute bars.
 *
 * The daily-bar backtest could only ask "buy the open, sell the close", which
 * is not remotely what he does. His profit is concentrated in trades held under
 * ten minutes, entered on a pullback, so the entry has to be found INSIDE the
 * session. That is what this file does.
 *
 * His rules, from the published methodology and the source's own
 * videos, in the order they fire:
 *
 *   1. A surge — the stock squeezes up on volume.
 *   2. A pullback of 1–3 red candles that does NOT retrace more than 50% of
 *      the surge ("I never wanted to pull back more than 50 of that move").
 *   3. Entry on the crossing candle — "the first candle to make a new high"
 *      after the pullback.
 *   4. Stop just below the pullback low; if that is more than 20c away, 20c
 *      ("if the stop is further than 20 cents away, I may decide to stop out
 *      minus 20 cents").
 *   5. Target at 2:1. Sell half there, move the stop to breakeven.
 *   6. Exit the rest on the first red candle close, or at the cutoff time.
 *
 * Minute bars still cannot order a stop and a target that both fall inside the
 * SAME minute. That is rarer than on daily bars but not zero, so it is counted
 * and always resolved against us.
 */

import { etMinutes } from './ettime.ts';

export type Minute = { ts: number; open: number; high: number; low: number; close: number; volume: number };

export const INTRADAY = {
  /** A surge is this much gain within the lookback, on above-average volume. */
  surgePct: 3,
  surgeLookback: 5,
  /** the momentum source's pullback is short — "2-3 red candles". */
  maxPullbackBars: 3,
  /** "I don't want to see it go below more than 50%" of the surge. */
  maxRetrace: 0.5,
  /** "If the stop is further than 20 cents away… stop out minus 20 cents." */
  maxStopDollars: 0.20,
  rewardRatio: 2,
  /** He trades 09:30–11:30; entries stop then, positions close by 16:00. */
  lastEntryMinute: 11 * 60 + 30,
  hardExitMinute: 15 * 60 + 55,
  /** No position may exceed this share of the minute's volume — a fill has to
   *  be plausible. Without it the simulator "buys" size that never existed. */
  maxVolumeShare: 0.10,
  /** Pattern-day-trader margin. Position value cannot exceed equity x this.
   *  Without it, a tight stop implies an enormous share count and the
   *  simulator trades capital the account does not have — which on the first
   *  run produced a median $3,946 position on a $2,000 account. */
  leverage: 4,
  /** Cents per share given up crossing the spread, each way. These are $2-$20
   *  micro caps entered on a breakout; the spread is real money when the median
   *  risk per share is 11c. This single number decides whether the strategy has
   *  an edge, so it is a parameter, not a hidden constant. */
  slippagePerShare: 0.01,
  /** Per-share commission, each way (per-share brokers, e.g. DAS/Lightspeed). */
  commissionPerShare: 0.002,
};

export type Costs = { slippagePerShare: number; commissionPerShare: number };

export type IntradayTrade = {
  symbol: string;
  date: string;
  entryTs: number;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  exitTs: number;
  exit: number;
  exitReason: 'stop' | 'target-then-red' | 'target-then-breakeven' | 'red-candle' | 'time' | 'ambiguous-stop';
  pnl: number;
  returnPct: number;
  heldMinutes: number;
  ambiguous: boolean;
};



/**
 * Find the first the momentum source-style pullback entry in a session and manage it.
 * Returns null when no valid setup appeared — which is itself a result: he
 * says most days offer under ten names, and some none at all.
 */
export function simulateSession(
  symbol: string,
  date: string,
  bars: Minute[],
  riskDollars: number,
  equity: number = Infinity,
  costs: Costs = {
    slippagePerShare: INTRADAY.slippagePerShare,
    commissionPerShare: INTRADAY.commissionPerShare,
  },
): IntradayTrade | null {
  if (bars.length < 10) return null;
  const sorted = [...bars].sort((a, b) => a.ts - b.ts);
  // Trailing average only. Averaging the whole session would let the surge test
  // consult bars that had not happened yet — lookahead that quietly makes every
  // entry smarter than it could have been in real time.
  const trailingAvgVol = (upTo: number): number => {
    const from = Math.max(0, upTo - 30);
    let sum = 0;
    for (let k = from; k < upTo; k++) sum += sorted[k].volume;
    return upTo > from ? sum / (upTo - from) : 0;
  };

  for (let i = INTRADAY.surgeLookback; i < sorted.length - 2; i++) {
    const minute = etMinutes(sorted[i].ts);
    if (minute < 9 * 60 + 30) continue;                 // no pre-market entries
    if (minute > INTRADAY.lastEntryMinute) break;       // his window has closed

    // --- 1. surge ---------------------------------------------------------
    const win = sorted.slice(i - INTRADAY.surgeLookback, i + 1);
    const surgeLow = Math.min(...win.map((b) => b.low));
    const surgeHigh = Math.max(...win.map((b) => b.high));
    if (surgeLow <= 0) continue;
    const surgeMove = ((surgeHigh - surgeLow) / surgeLow) * 100;
    if (surgeMove < INTRADAY.surgePct) continue;
    if (sorted[i].volume < trailingAvgVol(i)) continue; // "volume should be higher on green candles"

    // --- 2. pullback of 1-3 red candles, retracing under 50% --------------
    let j = i + 1, reds = 0;
    let pullLow = Infinity, pullHigh = -Infinity;
    while (j < sorted.length && reds < INTRADAY.maxPullbackBars && sorted[j].close < sorted[j].open) {
      pullLow = Math.min(pullLow, sorted[j].low);
      pullHigh = Math.max(pullHigh, sorted[j].high);
      reds++; j++;
    }
    if (reds === 0 || j >= sorted.length) continue;
    const retrace = (surgeHigh - pullLow) / (surgeHigh - surgeLow);
    if (retrace > INTRADAY.maxRetrace) continue;        // too deep — not his pattern

    // --- 3. entry on the crossing candle ----------------------------------
    const prior = sorted[j - 1];
    const trigger = prior.high;
    const cross = sorted[j];
    if (cross.high < trigger) continue;                 // no new high made; not a valid entry
    // We pay up to get in: the fill is the trigger plus the spread we cross.
    const entry = Math.max(trigger, cross.open) + costs.slippagePerShare;

    // --- 4. stop and size --------------------------------------------------
    const rawStop = Math.min(pullLow, prior.low);
    const stop = Math.max(rawStop, entry - INTRADAY.maxStopDollars);
    const risk = entry - stop;
    if (!(risk > 0.005)) continue;                      // degenerate stop
    const target = entry + risk * INTRADAY.rewardRatio;

    let shares = Math.floor(riskDollars / risk);
    shares = Math.min(shares, Math.floor(cross.volume * INTRADAY.maxVolumeShare));
    // The account has to be able to hold it. A 2c stop implies 5,000 shares on
    // $100 of risk, which is a $25,000 position — impossible on a small account
    // and the main reason the uncapped run looked spectacular.
    if (Number.isFinite(equity)) {
      shares = Math.min(shares, Math.floor((equity * INTRADAY.leverage) / entry));
    }
    if (shares < 1) continue;                           // no plausible fill

    // --- 5/6. manage the position -----------------------------------------
    //
    // Management starts on the bar AFTER entry, and this is not a detail.
    // We enter intrabar, the moment price crosses the prior high. That cross
    // happens at some unknown point inside the entry candle, and the candle's
    // low may well have printed BEFORE it. Testing the entry bar's own low
    // against the stop therefore stops us out on a dip we were never in — it
    // reported a median hold of zero minutes and a 70% stop-out rate that were
    // both artefacts. The next bar is the first whose full range we can honestly
    // claim to have been exposed to.
    let half = false, effStop = stop, realised = 0, remaining = shares;
    for (let k = j + 1; k < sorted.length; k++) {
      const b = sorted[k];
      const hitStop = b.low <= effStop;
      const hitTarget = !half && b.high >= target;
      const ambiguous = hitStop && hitTarget;

      if (hitStop) {
        // Always resolve an ambiguous minute against us.
        realised += (effStop - entry) * remaining;
        return done(b, effStop, ambiguous ? 'ambiguous-stop' : half ? 'target-then-breakeven' : 'stop', ambiguous);
      }
      if (hitTarget) {
        const sell = Math.floor(remaining / 2);
        realised += (target - entry) * sell;
        remaining -= sell;
        half = true;
        effStop = entry;                                 // "adjust my stop to my entry price"
        continue;
      }
      // the momentum source, verbatim: "If I haven't already sold 1/2, the first candle to
      // close red is an exit indicator. If I've already sold 1/2, I'll hold
      // through red candles as long as my breakeven stop doesn't hit."
      // This was implemented inverted — exiting on red only AFTER taking half,
      // which is the opposite of his rule and cut the winners while riding the
      // losers into their stops.
      if (!half && b.close < b.open) {
        realised += (b.close - entry) * remaining;
        return done(b, b.close, 'red-candle', false);
      }
      if (etMinutes(b.ts) >= INTRADAY.hardExitMinute) {
        realised += (b.close - entry) * remaining;
        return done(b, b.close, 'time', false);
      }
    }
    const last = sorted.at(-1)!;
    realised += (last.close - entry) * remaining;
    return done(last, last.close, 'time', false);

    function done(b: Minute, px: number, reason: IntradayTrade['exitReason'], amb: boolean): IntradayTrade {
      // Selling also crosses the spread, and both sides pay commission. On a
      // strategy whose median risk is 11c a share these costs are not a
      // rounding error — they are most of the edge.
      const exitSlip = costs.slippagePerShare * shares;
      const commission = costs.commissionPerShare * shares * 2;
      const net = realised - exitSlip - commission;
      return {
        symbol, date,
        entryTs: cross.ts, entry, stop, target, shares,
        exitTs: b.ts, exit: px - costs.slippagePerShare, exitReason: reason,
        pnl: net,
        returnPct: (net / (entry * shares)) * 100,
        heldMinutes: Math.round((b.ts - cross.ts) / 60000),
        ambiguous: amb,
      };
    }
  }
  return null;
}
