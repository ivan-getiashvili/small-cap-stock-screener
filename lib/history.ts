/**
 * What happened to every name the screener put in front of you.
 *
 * For each morning, each name is recorded as it looked when it first made the
 * list, and after the close it is scored on the regular session it was flagged
 * for: open to high, open to close, open to low, and the gap from the previous
 * close. Losers are recorded exactly like winners — the section exists to show
 * how these stocks actually behave, and a record that kept only the runners
 * would show whatever it was built to show.
 *
 * Stored in data/history.json, committed by CI, so it accumulates across runs.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Bar } from './types.ts';

export const HISTORY_FILE = 'data/history.json';

export type Performance = {
  open: number; high: number; low: number; close: number; volume: number;
  prevClose: number | null;
  /** Open against the previous close. */
  gapPct: number | null;
  openToHighPct: number;
  openToClosePct: number;
  openToLowPct: number;
  /** From the pre-market price at the moment the name was flagged. */
  alertToHighPct: number | null;
  alertToClosePct: number | null;
  filledAt: string;
};

export type HistoryName = {
  symbol: string;
  legalName: string | null;
  business: string | null;
  list: 'shortlist' | 'watchlist';
  firstSeenAt: string;
  lastSeenAt: string;
  shortlistedAt: string | null;
  preMarketPrice: number;
  preMarketChangePct: number;
  prevClose: number | null;
  preMarketVolume: number | null;
  relVolume: number | null;
  floatShares: number | null;
  catalyst: string | null;
  extended: boolean;
  /** Criteria it failed; empty for shortlist names. */
  missing: string[];
  performance: Performance | null;
};

export type HistoryDay = { date: string; source: 'live' | 'replay'; names: HistoryName[] };
export type History = { version: 1; updatedAt: string; days: Record<string, HistoryDay> };

/** "2026-09-14", in New York. */
export function nyToday(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Has the regular session for `date` finished (with a little slack for final prints)? */
export function sessionComplete(date: string, now = new Date()): boolean {
  const today = nyToday(now);
  if (date < today) return true;
  if (date > today) return false;
  const hm = Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) * 60 +
    Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  return hm >= 16 * 60 + 20;
}

export async function loadHistory(): Promise<History> {
  try {
    const h = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
    if (h?.version === 1 && h.days) return h;
  } catch { /* first run */ }
  return { version: 1, updatedAt: new Date().toISOString(), days: {} };
}

export async function saveHistory(h: History): Promise<void> {
  h.updatedAt = new Date().toISOString();
  await mkdir('data', { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(h, null, 1));
}

function snapshot(r: any, list: 'shortlist' | 'watchlist', at: string): HistoryName {
  return {
    symbol: r.symbol,
    legalName: r.legalName ?? r.name ?? null,
    business: r.business ?? null,
    list,
    firstSeenAt: at,
    lastSeenAt: at,
    shortlistedAt: list === 'shortlist' ? at : null,
    preMarketPrice: r.preMarketPrice,
    preMarketChangePct: r.preMarketChangePct,
    prevClose: r.prevClose ?? null,
    preMarketVolume: r.preMarketVolume ?? null,
    relVolume: r.relVolume ?? null,
    floatShares: r.float?.shares ?? null,
    catalyst: r.catalyst?.found ? (r.catalyst.subject || r.catalyst.headline || r.catalyst.kind) : null,
    extended: !!r.extended,
    missing: (r.checks ?? []).filter((c: any) => !c.ok).map((c: any) => c.name),
    performance: null,
  };
}

/**
 * Merge one scan into the day. A name keeps the moment it FIRST appeared; if a
 * watchlist name later clears all five, it is upgraded and re-snapshotted at
 * that moment, because the time it became a trade candidate is what matters.
 */
export function recordScan(h: History, date: string, payload: any, source: 'live' | 'replay', at: string): number {
  const day = (h.days[date] ??= { date, source, names: [] });
  let added = 0;
  const rows: [any, 'shortlist' | 'watchlist'][] = [
    ...(payload.shortlist ?? []).map((r: any) => [r, 'shortlist'] as [any, 'shortlist']),
    ...(payload.watchlist ?? []).map((r: any) => [r, 'watchlist'] as [any, 'watchlist']),
  ];
  for (const [r, list] of rows) {
    const existing = day.names.find((n) => n.symbol === r.symbol);
    if (!existing) { day.names.push(snapshot(r, list, at)); added++; continue; }
    existing.lastSeenAt = at;
    if (list === 'shortlist' && existing.list !== 'shortlist') {
      const upgraded = snapshot(r, 'shortlist', existing.firstSeenAt);
      upgraded.lastSeenAt = at;
      upgraded.shortlistedAt = at;
      Object.assign(existing, upgraded);
    }
  }
  return added;
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;

/**
 * Score every recorded name whose session has closed. Bars come from the
 * caller so this stays testable and vendor-neutral.
 */
export async function fillPerformance(
  h: History,
  getBars: (symbol: string, days: number) => Promise<Bar[]>,
  maxSymbols = 80,
): Promise<number> {
  const cache = new Map<string, Bar[]>();
  let filled = 0, asked = 0;
  for (const day of Object.values(h.days).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!sessionComplete(day.date)) continue;
    for (const n of day.names) {
      if (n.performance) continue;
      if (!cache.has(n.symbol)) {
        if (asked >= maxSymbols) return filled;
        asked++;
        cache.set(n.symbol, await getBars(n.symbol, 45).catch(() => []));
      }
      const bars = cache.get(n.symbol)!;
      const i = bars.findIndex((b) => b.date === day.date);
      if (i < 0) continue;                                // not published yet; next run tries again
      const b = bars[i];
      if (!(b.open > 0)) continue;
      const prevClose = i > 0 ? bars[i - 1].close : n.prevClose;
      n.performance = {
        open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
        prevClose: prevClose ?? null,
        gapPct: prevClose ? pct(b.open, prevClose) : null,
        openToHighPct: pct(b.high, b.open),
        openToClosePct: pct(b.close, b.open),
        openToLowPct: pct(b.low, b.open),
        alertToHighPct: n.preMarketPrice > 0 ? pct(b.high, n.preMarketPrice) : null,
        alertToClosePct: n.preMarketPrice > 0 ? pct(b.close, n.preMarketPrice) : null,
        filledAt: new Date().toISOString(),
      };
      filled++;
    }
  }
  return filled;
}
