/**
 * Databento — minute bars, and a survivorship-free historical universe.
 *
 * Dataset choice is the single most important decision in this file, and it is
 * not obvious. Measured against FTFT's real 52,847,168-share day:
 *
 *     DBEQ.BASIC    0.1%   of true volume
 *     EQUS.MINI     1.2%
 *     XNAS.ITCH     3.8%   (Nasdaq exchange only)
 *     XNAS.BASIC   76.6%   <- includes the FINRA/Nasdaq TRF
 *     EQUS.SUMMARY  100.8% but daily bars only
 *
 * Most small-cap volume prints off-exchange through the TRF, so any dataset
 * without it reports a few percent of reality. Since relative volume and float
 * rotation ARE the strategy, picking the wrong one here would not degrade the
 * screener — it would silently invert it.
 *
 * So: XNAS.BASIC for minute bars, EQUS.SUMMARY for the daily universe and for
 * the true daily volume we calibrate the minute bars against.
 */
import { appendFile, writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://hist.databento.com/v0';
export const MINUTE_DATASET = 'XNAS.BASIC';
export const DAILY_DATASET = 'EQUS.SUMMARY';
/** Databento prices are fixed-point integers at 1e-9. */
const PRICE_SCALE = 1e9;
/** The API rejects symbol lists longer than this when mapping symbols. */
export const MAX_SYMBOLS = 2000;

function key(): string {
  const k = process.env.DATABENTO_KEY;
  if (!k) throw new Error('DATABENTO_KEY is not set — put it in .env.local');
  return k;
}

function auth(): string {
  return 'Basic ' + Buffer.from(`${key()}:`).toString('base64');
}

/**
 * Always POST. A batch of 2,000 symbols overflows the URL length limit and
 * nginx answers 414 before Databento ever sees the request, so GET silently
 * caps how wide a query can be.
 */
async function call(path: string, params: Record<string, string>, timeoutMs = 600_000): Promise<Response> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Databento ${path} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** Dollars this query would cost. Always check before a large pull. */
export async function getCost(params: {
  dataset: string; symbols: string; schema: string; start: string; end: string;
}): Promise<number> {
  const res = await call('metadata.get_cost', params, 60_000);
  return Number(await res.text());
}

export type DbBar = {
  symbol: string;
  /** Epoch milliseconds, UTC. */
  ts: number;
  open: number; high: number; low: number; close: number; volume: number;
};

/**
 * Stream a CSV time-series query, parsing rows as they arrive.
 *
 * These responses reach hundreds of megabytes for a wide date range, so the
 * body is consumed incrementally rather than buffered — otherwise a two-year
 * pull exhausts memory before it finishes.
 */
export async function* streamBars(params: {
  dataset: string; symbols: string[]; schema: 'ohlcv-1m' | 'ohlcv-1d';
  start: string; end: string;
}): AsyncGenerator<DbBar> {
  if (params.symbols.length > MAX_SYMBOLS) {
    throw new Error(`${params.symbols.length} symbols exceeds the ${MAX_SYMBOLS} limit — batch them`);
  }
  const res = await call('timeseries.get_range', {
    dataset: params.dataset,
    symbols: params.symbols.join(','),
    schema: params.schema,
    start: params.start,
    end: params.end,
    encoding: 'csv',
    map_symbols: 'true',
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let header: string[] | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const cells = line.split(',');
      if (!header) { header = cells; continue; }
      const row: Record<string, string> = {};
      header.forEach((h, i) => (row[h] = cells[i]));
      const symbol = (row.symbol ?? '').trim();
      if (!symbol) continue;
      yield {
        symbol,
        ts: Number(row.ts_event) / 1e6,
        open: Number(row.open) / PRICE_SCALE,
        high: Number(row.high) / PRICE_SCALE,
        low: Number(row.low) / PRICE_SCALE,
        close: Number(row.close) / PRICE_SCALE,
        volume: Number(row.volume),
      };
    }
  }
}

/**
 * Every symbol Databento defined on a given date — INCLUDING names that have
 * since delisted. This is what makes a survivorship-free backtest possible:
 * building the universe from today's listings would silently drop every stock
 * that collapsed, which for small caps is most of the losers.
 *
 * Verified: 37 of 40 probed delisted tickers still return minute bars.
 */
export async function listSymbolsOn(dateIso: string, dataset = DAILY_DATASET): Promise<string[]> {
  const end = new Date(Date.parse(dateIso + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const res = await call('timeseries.get_range', {
    dataset, symbols: 'ALL_SYMBOLS', schema: 'definition',
    start: `${dateIso}T00:00:00Z`, end: `${end}T00:00:00Z`, encoding: 'csv',
  });
  const text = await res.text();
  const lines = text.split('\n');
  const header = lines[0]?.split(',') ?? [];
  const idx = header.indexOf('raw_symbol');
  if (idx < 0) return [];
  const out = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i].split(',')[idx]?.trim().toUpperCase();
    // Common stock only: skip warrants, units, rights and preferreds, which
    // distort float maths because they are claims on shares, not shares.
    if (s && /^[A-Z]{1,5}$/.test(s)) out.add(s);
  }
  return [...out];
}

/** Split a symbol list into API-sized batches. */
export function batches<T>(items: T[], size = MAX_SYMBOLS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
