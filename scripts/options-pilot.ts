/**
 * Would a call option capture the runner better than the stock? A pilot on real
 * option quotes -> data/options-pilot.json
 *
 * Run:  node --experimental-strip-types scripts/options-pilot.ts [--n=150] [--dry]
 * Needs DATABENTO_KEY and the caches left by scripts/early-flags.ts. Roughly
 * $0.04 of OPRA data per stock-day that has listed options.
 *
 * Ivan's idea (2026-09-14): instead of holding the stock with no stop, buy a
 * call — a weekly or a monthly — so a fade costs only some premium while a
 * 20%+ run is captured in full. The question is what the call costs on the
 * morning of a 10%+ gap, when the whole market already expects a big move.
 *
 * Method, on a seeded random draw of the 08:45-flagged stock-days that have
 * listed options (most small caps have none):
 * - At 09:31 buy, at the ask, the call with the strike nearest above the open,
 *   on the nearest expiry at least one day out ("weekly") and on the nearest at
 *   least 20 days out ("monthly").
 * - Sell at the bid at noon, at the close, or the first minute the stock trades
 *   10% / 20% above its open. Options do not trade pre-market, so the open is
 *   the earliest entry.
 * - Report the premium as a share of the stock price, the option's own spread,
 *   and the P&L per trade both as a share of the premium and as a share of the
 *   stock exposure, next to the stock bought at the same moment.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

type Bar = [number, number, number, number, number, number];
type OptQuote = { ts: number; symbol: string; bid: number; ask: number };

const FULL_DAY = ['data/db/minutes', 'data/db/strategy-bars'];
const OPRA = 'data/db/opra';
const OUT = 'data/options-pilot.json';
const N = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? '150');
const DRY = process.argv.includes('--dry');
const PRICE_SCALE = 1e9;

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
const nyMinute = (ts: number, off: number) => (((Math.floor(ts / 60_000) - off) % 1440) + 1440) % 1440;
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
function dedupe(bars: Bar[]): Bar[] { const out: Bar[] = []; for (const b of [...bars].sort((a, c) => a[0] - c[0])) if (!out.length || out[out.length - 1][0] !== b[0]) out.push(b); return out; }
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

const auth = 'Basic ' + Buffer.from(`${process.env.DATABENTO_KEY}:`).toString('base64');
async function db(path: string, params: Record<string, string>): Promise<Response> {
  return fetch(`https://hist.databento.com/v0/${path}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(300_000) });
}

/** OSI symbol -> parts. "CORZ  240809C00010000" */
function parseOsi(s: string): { expiry: string; right: 'C' | 'P'; strike: number } | null {
  const m = /^[A-Z.]+\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s.trim());
  return m ? { expiry: `20${m[1]}-${m[2]}-${m[3]}`, right: m[4] as 'C' | 'P', strike: Number(m[5]) / 1000 } : null;
}

/** The day's option quotes for one underlying, from the cache or OPRA. Null when the name has no listed options. */
async function chainQuotes(symbol: string, date: string, spend: { usd: number }): Promise<OptQuote[] | null> {
  const path = `${OPRA}/${date}/${symbol}.json`;
  const hit = await readJson<OptQuote[] | null | undefined>(path, undefined);
  if (hit !== undefined) return hit;
  const params = { dataset: 'OPRA.PILLAR', symbols: `${symbol}.OPT`, stype_in: 'parent', schema: 'cbbo-1m', start: new Date(nyMs(date, 570)).toISOString(), end: new Date(nyMs(date, 960)).toISOString() };
  const cost = await db('metadata.get_cost', params);
  if (cost.status === 422) { await mkdir(`${OPRA}/${date}`, { recursive: true }); await writeFile(path, 'null'); return null; }
  if (!cost.ok) throw new Error(`get_cost HTTP ${cost.status}: ${(await cost.text()).slice(0, 200)}`);
  spend.usd += Number(await cost.text());
  if (DRY) return [];
  const res = await db('timeseries.get_range', { ...params, encoding: 'csv', map_symbols: 'true' });
  if (!res.ok) throw new Error(`get_range HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const lines = text.split('\n'), header = lines[0].split(',');
  const iTs = header.indexOf('ts_recv'), iBid = header.indexOf('bid_px_00'), iAsk = header.indexOf('ask_px_00'), iSym = header.indexOf('symbol');
  const out: OptQuote[] = [];
  const px = (raw: string) => { const v = Number(raw) / PRICE_SCALE; return v > 0 && v < 1e6 ? v : NaN; };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= iSym) continue;
    const sym = c[iSym].trim();
    if (!/[C]\d{8}$/.test(sym)) continue;                         // calls only
    out.push({ ts: Number(c[iTs]) / 1e6, symbol: sym, bid: px(c[iBid]), ask: px(c[iAsk]) });
  }
  await mkdir(`${OPRA}/${date}`, { recursive: true });
  await writeFile(path, JSON.stringify(out));
  return out;
}

type Result = {
  date: string; symbol: string; open: number; expiryKind: 'weekly' | 'monthly'; contract: string; daysToExpiry: number; strike: number;
  premium: number; premiumPctOfStock: number; spreadPctOfPremium: number;
  stock: Record<string, number>; option: Record<string, number>;    // return on the stock / on the premium, per exit
};

async function main() {
  const sample = (JSON.parse(await readFile('data/early-flags.json', 'utf8')).trades as any[]).filter((t) => t.flag === '08:45');
  const rnd = mulberry32(7);
  const order = [...sample].sort(() => rnd() - 0.5);
  const spend = { usd: 0 };
  const results: Result[] = [];
  let checked = 0, optionable = 0, noQuoteAtOpen = 0;

  // Each optionable name means downloading its whole chain for the day, tens
  // of megabytes, so a few run at once.
  let next = 0;
  const handle = async (t: any) => {
    checked++;
    const quotes = await chainQuotes(t.symbol, t.date, spend).catch((e) => { console.warn(`${t.date} ${t.symbol}: ${(e as Error).message}`); return undefined; });
    if (quotes === undefined || quotes === null) return;
    optionable++;
    if (DRY) return;
    if (optionable % 10 === 0) console.log(`  checked ${checked}, with options ${optionable}, $${spend.usd.toFixed(2)}`);

    const off = nyOffsetMin(t.date);
    const full: Record<string, Bar[]> = {};
    for (const dir of FULL_DAY) Object.assign(full, await readJson<Record<string, Bar[]>>(`${dir}/${t.date}.json`, {}));
    const bars = dedupe(full[t.symbol] ?? []);
    const minutes = bars.map((b) => nyMinute(b[0], off));
    const openIdx = minutes.findIndex((m) => m >= 570);
    if (openIdx < 0 || minutes[openIdx] !== 570) return;
    const open = bars[openIdx][1];
    const entryTs = nyMs(t.date, 571);

    // Contracts: strike nearest above the open; expiries nearest ≥1 day and ≥20 days.
    const byContract = new Map<string, OptQuote[]>();
    for (const q of quotes) (byContract.get(q.symbol) ?? byContract.set(q.symbol, []).get(q.symbol)!).push(q);
    const contracts = [...byContract.keys()].map((s) => ({ symbol: s, ...parseOsi(s)! })).filter((c) => c.expiry && c.strike >= open);
    const dte = (exp: string) => (Date.parse(exp) - Date.parse(t.date)) / 86_400_000;
    for (const [kind, minDays] of [['weekly', 1], ['monthly', 20]] as const) {
      const expiries = [...new Set(contracts.filter((c) => dte(c.expiry) >= minDays).map((c) => c.expiry))].sort();
      if (!expiries.length) continue;
      const exp = expiries[0];
      const cands = contracts.filter((c) => c.expiry === exp).sort((a, b) => a.strike - b.strike);
      if (!cands.length) continue;
      const c = cands[0];
      const qs = byContract.get(c.symbol)!.sort((a, b) => a.ts - b.ts);
      const at = (ts: number) => { let q: OptQuote | null = null; for (const x of qs) { if (x.ts <= ts) q = x; else break; } return q && ts - q.ts <= 15 * 60_000 && q.bid > 0 && q.ask >= q.bid ? q : null; };
      const q0 = at(entryTs);
      if (!q0) { noQuoteAtOpen++; continue; }
      const premium = q0.ask;
      const stockBuy = open;
      const firstAbove = (mult: number) => { for (let i = openIdx + 1; i < bars.length && minutes[i] < 960; i++) if (bars[i][2] > open * mult) return minutes[i]; return null; };
      const exits: Record<string, number> = { noon: 720, close: 959 };
      const r10 = firstAbove(1.10), r20 = firstAbove(1.20);
      const exitMinute: Record<string, number> = { 'noon': 720, 'close': 959, '+10% or close': r10 ?? 959, '+20% or close': r20 ?? 959 };
      const stock: Record<string, number> = {}, option: Record<string, number> = {};
      for (const [name, m] of Object.entries(exitMinute)) {
        const k = minutes.reduce((best, mm, i) => (mm <= m && i > openIdx ? i : best), openIdx);
        stock[name] = (name.startsWith('+') && ((name === '+10% or close' && r10) || (name === '+20% or close' && r20))) ? (name === '+10% or close' ? 0.10 : 0.20) : bars[k][4] / stockBuy - 1;
        const q1 = at(nyMs(t.date, m + 1));
        option[name] = q1 ? q1.bid / premium - 1 : -1;               // no quote to sell into: written off
      }
      void exits;
      results.push({ date: t.date, symbol: t.symbol, open, expiryKind: kind, contract: c.symbol, daysToExpiry: Math.round(dte(exp)), strike: c.strike, premium, premiumPctOfStock: premium / open, spreadPctOfPremium: (q0.ask - q0.bid) / q0.ask, stock, option });
    }
  };
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < order.length && optionable < N) await handle(order[next++]); }));
  console.log(`checked ${checked} flagged stock-days: ${optionable} had listed options (${(100 * optionable / checked).toFixed(0)}%); ${noQuoteAtOpen} contracts had no usable quote at 09:31; OPRA spend $${spend.usd.toFixed(2)}`);
  if (DRY) return;

  for (const kind of ['weekly', 'monthly'] as const) {
    const rs = results.filter((r) => r.expiryKind === kind);
    if (!rs.length) continue;
    console.log(`\n${kind} call, strike nearest above the open (${rs.length} trades): median days to expiry ${median(rs.map((r) => r.daysToExpiry))}, premium = ${pct(median(rs.map((r) => r.premiumPctOfStock)))} of the stock price (median), option spread = ${pct(median(rs.map((r) => r.spreadPctOfPremium)))} of the premium`);
    console.log(`${'exit'.padEnd(16)}${'stock: mean'.padStart(12)}${'won'.padStart(6)}${'call: mean on premium'.padStart(22)}${'median'.padStart(8)}${'won'.padStart(6)}${'call P&L as % of stock exposure'.padStart(32)}`);
    for (const name of Object.keys(rs[0].option)) {
      const st = rs.map((r) => r.stock[name]), op = rs.map((r) => r.option[name]);
      const asStock = rs.map((r) => r.option[name] * r.premiumPctOfStock);
      console.log(`${name.padEnd(16)}${pct(mean(st)).padStart(12)}${`${(100 * st.filter((x) => x > 0).length / st.length).toFixed(0)}%`.padStart(6)}${pct(mean(op)).padStart(22)}${pct(median(op)).padStart(8)}${`${(100 * op.filter((x) => x > 0).length / op.length).toFixed(0)}%`.padStart(6)}${pct(mean(asStock)).padStart(32)}`);
    }
  }
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), checked, optionable, noQuoteAtOpen, spend: +spend.usd.toFixed(2), results }));
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
