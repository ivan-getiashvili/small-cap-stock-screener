/**
 * Which symbol-days are worth buying minute data for.
 *
 * This selection is where a backtest is most easily corrupted, so the rule is
 * deliberately built to keep losers in the sample:
 *
 *   A day qualifies when its HIGH reached +10% over the prior close —
 *   NOT when it CLOSED up 10%.
 *
 * Selecting on the close would silently drop every stock that spiked 12% at
 * 10am and died at -5% by the bell, which is exactly the trade this strategy
 * has to be measured against. Selecting on the high keeps the fades.
 *
 * Known residual bias, stated rather than buried: the volume screen uses the
 * full session's volume, which is not knowable at 10am. A stock that reaches
 * +10% intraday almost always ends with elevated volume, so the effect is
 * small — but it is real and it points optimistic.
 */
import { readFile, readdir } from 'node:fs/promises';

export const DAILY_DIR = 'data/db/daily';

export const SELECT = {
  minIntradayHighPct: 10,   // the momentum source's "up at least 10%", measured at the HIGH
  minVolumeMultiple: 3,     // generous; the intraday signal does the real work
  priceMin: 2, priceMax: 20,
  minDollarVolume: 1_000_000,
};

export type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type Candidate = { symbol: string; date: string; prevClose: number; avgVol50: number; dayVolume: number };

export function findCandidateDays(symbol: string, bars: Daily[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 51; i < bars.length; i++) {
    const d = bars[i], prev = bars[i - 1];
    if (!(prev.close >= SELECT.priceMin && prev.close <= SELECT.priceMax)) continue;
    if (((d.high - prev.close) / prev.close) * 100 < SELECT.minIntradayHighPct) continue;

    const window = bars.slice(i - 50, i);
    const avg = window.reduce((a, b) => a + b.volume, 0) / window.length;
    if (!(avg > 0) || d.volume < avg * SELECT.minVolumeMultiple) continue;
    if (d.close * d.volume < SELECT.minDollarVolume) continue;

    out.push({ symbol, date: d.date, prevClose: prev.close, avgVol50: avg, dayVolume: d.volume });
  }
  return out;
}

export async function loadCandidateDays(): Promise<{ byDate: Map<string, Candidate[]>; total: number }> {
  const files = (await readdir(DAILY_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error(`No daily history in ${DAILY_DIR}/. Run fetch-db-universe.ts first.`);

  const byDate = new Map<string, Candidate[]>();
  let total = 0;
  for (const f of files) {
    try {
      const bars: Daily[] = JSON.parse(await readFile(`${DAILY_DIR}/${f}`, 'utf8'));
      for (const c of findCandidateDays(f.replace('.json', ''), bars)) {
        if (!byDate.has(c.date)) byDate.set(c.date, []);
        byDate.get(c.date)!.push(c);
        total++;
      }
    } catch { /* skip a corrupt cache entry */ }
  }
  return { byDate, total };
}

export function nextDay(d: string): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
}
