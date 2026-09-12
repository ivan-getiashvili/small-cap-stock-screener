/**
 * Alternative exit rules, tested side by side.
 *
 * One rule in isolation proves nothing: if a single arbitrary stop loses money
 * you cannot tell whether the SIGNAL is worthless or the EXIT is. Running
 * several over identical signals separates those two questions.
 *
 * `ambiguous` counts bars where the day's range covered both the stop and the
 * target. Daily data cannot order those two events, so the result for those
 * bars is an assumption, not a measurement — and the count tells you how much
 * of the answer rests on it.
 */
import type { Bar } from './types.ts';

export type VariantResult = { pnlPct: number; outcome: 'stop' | 'target' | 'close' | 'open'; ambiguous: boolean };

export type Variant = {
  key: string;
  label: string;
  note: string;
  run: (bar: Bar, signalClose: number) => VariantResult | null;
};

export const VARIANTS: Variant[] = [
  {
    key: 'cameron_2to1',
    label: 'Cameron 4% stop, 2:1 target',
    note: 'His stated rules: ~20c stop on a $5 stock, target twice the risk. Entry at the open.',
    run: (bar) => {
      const e = bar.open; if (!(e > 0)) return null;
      const stop = e * 0.96, target = e * 1.08;
      const hitStop = bar.low <= stop, hitTarget = bar.high >= target;
      if (hitStop) return { pnlPct: -4, outcome: 'stop', ambiguous: hitTarget };
      if (hitTarget) return { pnlPct: 8, outcome: 'target', ambiguous: false };
      return { pnlPct: ((bar.close - e) / e) * 100, outcome: 'close', ambiguous: false };
    },
  },
  {
    key: 'wide_stop',
    label: '10% stop, 2:1 target',
    note: 'Same shape, wider stop. Tests whether 4% is simply inside these stocks’ daily noise.',
    run: (bar) => {
      const e = bar.open; if (!(e > 0)) return null;
      const stop = e * 0.90, target = e * 1.20;
      const hitStop = bar.low <= stop, hitTarget = bar.high >= target;
      if (hitStop) return { pnlPct: -10, outcome: 'stop', ambiguous: hitTarget };
      if (hitTarget) return { pnlPct: 20, outcome: 'target', ambiguous: false };
      return { pnlPct: ((bar.close - e) / e) * 100, outcome: 'close', ambiguous: false };
    },
  },
  {
    key: 'open_to_close',
    label: 'Buy open, sell close (no stop)',
    note: 'The pure question: does the setup drift up or down over the session?',
    run: (bar) => {
      const e = bar.open; if (!(e > 0)) return null;
      return { pnlPct: ((bar.close - e) / e) * 100, outcome: 'close', ambiguous: false };
    },
  },
  {
    key: 'scalp_5pct',
    label: 'Buy open, take +5%, else close',
    note: 'Sells into strength the way both men describe, rather than holding for a big target.',
    run: (bar) => {
      const e = bar.open; if (!(e > 0)) return null;
      if (bar.high >= e * 1.05) return { pnlPct: 5, outcome: 'target', ambiguous: false };
      return { pnlPct: ((bar.close - e) / e) * 100, outcome: 'close', ambiguous: false };
    },
  },
  {
    key: 'overnight',
    label: 'Buy signal close, sell next open',
    note: 'Captures only the overnight gap — no intraday exposure at all.',
    run: (bar, signalClose) => {
      if (!(signalClose > 0)) return null;
      return { pnlPct: ((bar.open - signalClose) / signalClose) * 100, outcome: 'open', ambiguous: false };
    },
  },
];
