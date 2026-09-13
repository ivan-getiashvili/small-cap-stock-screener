/**
 * The two decision systems, kept deliberately separate.
 *
 *   gapFilter() — five pass/fail pillars. A stock either is or is not a
 *                     candidate. Source: the source's own video "Picking Stocks was HARD
 *                     Until I Learned This 5 Step Trick" (22 Oct 2025), where
 *                     he derives each threshold from the source's own P&L.
 *
 *   qualityScore()    — seven weighted indicators summing to 100, trade above 70.
 *                     Source: "How to Pick Stocks to Day Trade (with my 7-Step
 *                     Formula)" (9 Nov 2025), where he states the point weights.
 *
 * They are not blended. the momentum source decides WHICH stocks are candidates; the scoring source
 * decides HOW GOOD each candidate is. Every threshold lives in CRITERIA so it
 * can be tuned in one place without hunting through the logic.
 */
import type { Candidate, FilterResult, Quote, Score, Float, Bar } from './types.ts';

export const CRITERIA = {
  filter: {
    minChangePct: 10,        // "up at least 10% on the day already"
    minRelVolume: 5,         // "5x higher relative volume"
    priceMin: 2,             // "$2 to $20 is going to be our sweet spot"
    priceMax: 20,
    maxFloat: 10_000_000,    // "under 10 million shares"
    floatStretch: 20_000_000, // he'll "occasionally" go to 15-20M
    minGapPct: 2,            // "opening up at least 2% from the prior day's close"
    volumePotential: 25_000_000, // where his results cluster by end of day
  },
  score: {
    priceSweetLow: 3,        // "my sweet spot is stocks between three and $5"
    priceSweetHigh: 5,
    floatIdealMax: 5_000_000,   // "500,000, a million, 5 million shares"
    floatRejectAbove: 90_000_000, // he rejected a 94M float on camera
    minRotation: 3,          // "three times the rotation"
    goodRotation: 5,         // he praised "five or six times"
    tradeThreshold: 70,      // "if the total value is over 70"
  },
} as const;

/** the momentum source's five pillars. `hasNews === null` means we could not check. */
export function gapFilter(
  q: Quote,
  relVolume: number | null,
  floatShares: number | null,
  hasNews: boolean | null,
): FilterResult {
  const c = CRITERIA.gate;
  const pillars = [
    {
      name: 'Up ≥10% today',
      ok: q.changePct >= c.minChangePct,
      detail: `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(1)}%`,
    },
    {
      name: 'Relative volume ≥5×',
      ok: relVolume !== null && relVolume >= c.minRelVolume,
      detail: relVolume === null ? 'no history' : `${relVolume.toFixed(1)}×`,
    },
    {
      name: 'News catalyst',
      // Unknown is not a pass. the momentum source is emphatic that the catalyst comes
      // first, so absent evidence we fail the pillar rather than assume one.
      ok: hasNews === true,
      detail: hasNews === null ? 'not checked' : hasNews ? 'headline found' : 'none found',
    },
    {
      name: 'Price $2–$20',
      ok: q.price >= c.priceMin && q.price <= c.priceMax,
      detail: `$${q.price.toFixed(2)}`,
    },
    {
      name: 'Float <10M shares',
      ok: floatShares !== null && floatShares < c.maxFloat,
      detail:
        floatShares === null
          ? 'unknown'
          : `${(floatShares / 1e6).toFixed(1)}M${floatShares < c.floatStretch && floatShares >= c.maxFloat ? ' (stretch)' : ''}`,
    },
  ];
  const passedCount = pillars.filter((p) => p.ok).length;
  return { passed: pillars.every((p) => p.ok), pillars, passedCount };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** Map a value in [lo,hi] onto [1,max] points, saturating at both ends. */
const scale = (v: number, lo: number, hi: number, max: number) =>
  Math.round(clamp(1 + ((v - lo) / (hi - lo)) * (max - 1), 1, max));

export type ScoreInputs = {
  quote: Quote;
  floatShares: number | null;
  floatRotation: number | null;
  bestPriorSpikePct: number | null;
  hasNews: boolean | null;
  /** How many stocks in the whole market are up >20% and >100% right now. */
  market: { up20: number; up100: number };
  /** Minutes since 09:30 ET. Negative = pre-market. Null = market closed. */
  minutesFromOpen: number | null;
  /** Median dollar spread proxy: today's dollar volume. */
  dollarVolume: number;
};

/** the scoring source's seven indicators, with the source's own scoring anchors. */
export function qualityScore(i: ScoreInputs): Score {
  const s = CRITERIA.score;
  const parts: Score['parts'] = [];

  // P — Pattern and price (1-20). We can score price precisely; pattern needs
  // a chart read, so this axis is priced-based and stated as such.
  const p = i.quote.price;
  const inSweet = p >= s.priceSweetLow && p <= s.priceSweetHigh;
  const pricePts = inSweet ? 20 : p >= 1 && p <= 10 ? 12 : p > 10 && p <= 20 ? 7 : 2;
  parts.push({
    key: 'pattern_price',
    label: 'Pattern & price',
    points: pricePts,
    max: 20,
    why: inSweet ? `$${p.toFixed(2)} — in his $3–$5 sweet spot` : `$${p.toFixed(2)} — outside $3–$5`,
  });

  // R — Risk/reward (1-20). His anchor is 10:1 (make 50c-$1, risk 5-10c).
  // Without an entry we proxy with float rotation: the tighter the supply
  // against today's demand, the further the move can run against a fixed stop.
  const rot = i.floatRotation;
  const rrPts = rot === null ? 5 : scale(rot, 0.5, 10, 20);
  parts.push({
    key: 'risk_reward',
    label: 'Risk / reward',
    points: rrPts,
    max: 20,
    why: rot === null ? 'float unknown — cannot size the move' : `${rot.toFixed(1)}× float rotation`,
  });

  // E — Ease of entry and exit (1-10). Liquidity: dollar volume is the honest
  // proxy for "can I get filled", since we have no live bid/ask.
  const dv = i.dollarVolume;
  const easePts = scale(Math.log10(Math.max(dv, 1)), 5, 8, 10); // $100k -> $100M
  parts.push({
    key: 'ease',
    label: 'Ease of entry/exit',
    points: easePts,
    max: 10,
    why: `$${(dv / 1e6).toFixed(1)}M traded today`,
  });

  // P — Past performance, history of spiking (1-10).
  const spike = i.bestPriorSpikePct;
  const spikePts = spike === null ? 3 : scale(spike, 20, 200, 10);
  parts.push({
    key: 'history',
    label: 'History of spiking',
    points: spikePts,
    max: 10,
    why: spike === null ? 'no history' : `best prior day +${spike.toFixed(0)}% in last year`,
  });

  // A — At what time (1-20). His best window is the open; 2pm scores a 1.
  const m = i.minutesFromOpen;
  let timePts = 1;
  let timeWhy = 'market closed — score reflects a hypothetical open';
  if (m !== null) {
    if (m < 0) { timePts = 16; timeWhy = 'pre-market'; }
    else if (m <= 30) { timePts = 20; timeWhy = 'first 30 min'; }
    else if (m <= 60) { timePts = 17; timeWhy = 'first hour'; }
    else if (m <= 120) { timePts = 12; timeWhy = '9:30–11:30 window'; }
    else if (m <= 240) { timePts = 4; timeWhy = 'midday'; }
    else { timePts = 2; timeWhy = 'afternoon'; }
  }
  parts.push({ key: 'time', label: 'Time of day', points: timePts, max: 20, why: timeWhy });

  // R — Reason / catalyst (1-10).
  const newsPts = i.hasNews === true ? 10 : i.hasNews === false ? 2 : 4;
  parts.push({
    key: 'catalyst',
    label: 'Catalyst',
    points: newsPts,
    max: 10,
    why: i.hasNews === true ? 'news found today' : i.hasNews === false ? 'no news found' : 'not checked',
  });

  // E — Environment (1-10). His anchor: "half a dozen stocks up over 100%".
  const envPts = clamp(Math.round(1 + i.market.up100 * 1.5 + i.market.up20 / 12), 1, 10);
  parts.push({
    key: 'environment',
    label: 'Market environment',
    points: envPts,
    max: 10,
    why: `${i.market.up100} stocks up >100%, ${i.market.up20} up >20% today`,
  });

  const total = parts.reduce((a, b) => a + b.points, 0);
  return { total, tradeable: total > s.tradeThreshold, parts };
}

/** Today's volume vs the 50-day average, excluding today. the momentum source's pillar #2. */
export function relativeVolume(todayVolume: number, priorBars: Bar[]): { rel: number; avg: number } | null {
  const window = priorBars.slice(-50);
  if (window.length < 10) return null;   // too little history to mean anything
  const avg = window.reduce((a, b) => a + b.volume, 0) / window.length;
  if (avg <= 0) return null;
  return { rel: todayVolume / avg, avg };
}

/** Largest single-day % gain in the supplied bars. the scoring source's "former runner" test. */
export function bestSpike(bars: Bar[]): number | null {
  let best: number | null = null;
  for (let k = 1; k < bars.length; k++) {
    const prev = bars[k - 1].close, cur = bars[k].close;
    if (prev > 0) {
      const pct = ((cur - prev) / prev) * 100;
      if (best === null || pct > best) best = pct;
    }
  }
  return best;
}

/** Consecutive up-closes ending at the last bar. the scoring source prefers day 1. */
export function dayOfRun(bars: Bar[]): number {
  let n = 0;
  for (let k = bars.length - 1; k > 0; k--) {
    if (bars[k].close > bars[k - 1].close) n++;
    else break;
  }
  return n;
}
