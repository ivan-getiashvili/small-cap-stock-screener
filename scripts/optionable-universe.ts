/**
 * The smallest stocks that have weekly options, and how much they move
 * -> data/reference/weekly-optionable-bottom-decile.json
 *
 * Run:  node --experimental-strip-types scripts/optionable-universe.ts
 * Sources: Cboe's weeklys symbol directory (the stocks with weekly expirations),
 * Nasdaq's screener for market caps, the local daily bar cache for the moves.
 * Both downloads are kept under data/reference/ with their date, so the universe
 * can be rebuilt exactly.
 *
 * Ivan's request (2026-09-15): forget the micro caps without options; take all
 * optionable stocks, keep the bottom 10% by market cap, and see whether they
 * move enough for a weekly call to pay. This script builds that list and
 * measures the moves; scripts/weekly-cost.ts prices the calls.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getUniverse } from '../lib/sources/nasdaq.ts';

const REF = 'data/reference';
/** Which day's downloads to use: `--date=2026-09-14` rebuilds from the dated files; default today (fetches). */
const DATE = process.argv.find((a) => a.startsWith('--date='))?.split('=')[1] ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const FROM = '2024-08-01';

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const fmt = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`);

async function weeklys(): Promise<Set<string>> {
  const path = `${REF}/cboe-weeklys-${DATE}.csv`;
  let csv = await readFile(path, 'utf8').catch(() => '');
  if (!csv) {
    const res = await fetch('https://www.cboe.com/us/options/symboldir/weeklys_options/?download=csv', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Cboe weeklys directory: HTTP ${res.status}`);
    csv = await res.text();
    await writeFile(path, csv);
  }
  const out = new Set<string>();
  for (const line of csv.split('\n').slice(1)) { const m = /"([^"]*)"\s*$/.exec(line.trim()); if (m) out.add(m[1].toUpperCase()); }
  if (out.size < 300) throw new Error(`Cboe weeklys directory looks wrong: ${out.size} symbols`);
  return out;
}

async function universe(): Promise<any[]> {
  const path = `${REF}/nasdaq-universe-${DATE}.json`;
  const hit = await readJson<any[] | null>(path, null);
  if (hit) return hit;
  const { quotes } = await getUniverse();
  await writeFile(path, JSON.stringify(quotes));
  return quotes;
}

async function moves(names: string[]): Promise<Record<string, number>> {
  let d = 0, w = 0, a3 = 0, a5 = 0, a10 = 0, gap5 = 0, gap10 = 0, w5 = 0, w10 = 0, up5 = 0;
  const absDay: number[] = [], absWeek: number[] = [];
  for (const s of names) {
    const b = (await readJson<Daily[]>(`data/db/daily/${s}.json`, [])).filter((x) => x.date >= FROM);
    for (let i = 1; i < b.length; i++) {
      const r = b[i].close / b[i - 1].close - 1, g = b[i].open / b[i - 1].close - 1;
      d++; absDay.push(Math.abs(r));
      if (Math.abs(r) >= 0.03) a3++; if (Math.abs(r) >= 0.05) a5++; if (Math.abs(r) >= 0.10) a10++;
      if (Math.abs(g) >= 0.05) gap5++; if (Math.abs(g) >= 0.10) gap10++;
      if (i >= 5) { const wr = b[i].close / b[i - 5].close - 1; w++; absWeek.push(Math.abs(wr)); if (Math.abs(wr) >= 0.05) w5++; if (Math.abs(wr) >= 0.10) w10++; if (wr >= 0.05) up5++; }
    }
  }
  return { days: d, medianAbsDay: median(absDay), day3: a3 / d, day5: a5 / d, day10: a10 / d, gap5: gap5 / d, gap10: gap10 / d, medianAbsWeek: median(absWeek), week5: w5 / w, week10: w10 / w, weekUp5: up5 / w };
}

async function main() {
  await mkdir(REF, { recursive: true });
  const weekly = await weeklys();
  const etfs = new Set(await readJson<string[]>('data/db/etfs.json', []));
  const caps = new Map<string, any>((await universe()).filter((q) => q.marketCap > 0).map((q) => [q.symbol, q]));
  const stocks = [...weekly].filter((s) => !etfs.has(s) && caps.has(s)).map((s) => caps.get(s)).sort((a, b) => a.marketCap - b.marketCap);
  const n = stocks.length, dec = Math.ceil(n / 10);
  console.log(`Cboe weeklys: ${weekly.size} symbols, ${n} of them stocks with a market cap. Deciles: ${[1, 2, 3, 5, 7, 9, 10].map((d) => `${d}:${fmt(stocks[Math.min(n - 1, d * dec - 1)].marketCap)}`).join('  ')}`);
  const bottom = stocks.slice(0, dec);
  console.log(`Bottom 10%: ${bottom.length} stocks, ${fmt(bottom[0].marketCap)} – ${fmt(bottom[bottom.length - 1].marketCap)}, median price $${median(bottom.map((s) => s.price))}`);
  console.log(bottom.map((s) => s.symbol).join(' '));
  const groups: [string, string[]][] = [['bottom 10% by cap', bottom.map((s) => s.symbol)], ['2nd decile', stocks.slice(dec, 2 * dec).map((s) => s.symbol)], ['top 10%', stocks.slice(-dec).map((s) => s.symbol)]];
  const pct = (x: number) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`;
  const stats: Record<string, Record<string, number>> = {};
  for (const [label, names] of groups) {
    const m = await moves(names); stats[label] = m;
    console.log(`${label.padEnd(20)} median |day| ${pct(m.medianAbsDay)} · |day| ≥3% ${pct(m.day3)}, ≥5% ${pct(m.day5)}, ≥10% ${pct(m.day10)} · gap ≥5% ${pct(m.gap5)}, ≥10% ${pct(m.gap10)} · median |5-day| ${pct(m.medianAbsWeek)} · |5-day| ≥5% ${pct(m.week5)}, ≥10% ${pct(m.week10)} · 5-day up ≥5% ${pct(m.weekUp5)}`);
  }
  await writeFile(`${REF}/weekly-optionable-bottom-decile.json`, JSON.stringify({ asOf: DATE, count: n, bottom, stats }));
}

main().catch((e) => { console.error(e); process.exit(1); });
