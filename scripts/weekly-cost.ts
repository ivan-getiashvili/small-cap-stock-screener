/**
 * What a weekly call costs on the smallest weekly-optionable stocks, and what it
 * pays -> data/weekly-cost.json
 *
 * Run:  node --experimental-strip-types scripts/weekly-cost.ts [--dry]
 * Needs DATABENTO_KEY, data/reference/weekly-optionable-bottom-decile.json and
 * the daily bar cache. A few dollars of OPRA data.
 *
 * Ivan's question (2026-09-15): take the optionable stocks with the smallest
 * market caps; they move several percent a day. If a weekly call costs ~1% of
 * the stock, even a 5% move in a week pays. So: on those stocks, what does the
 * nearest weekly (and same-day, if any) at-the-money call actually cost at
 * 10:00 ET, and what does it pay at expiry?
 *
 * Two samples of stock-days from the last year:
 *   random     four random sessions per stock;
 *   gap days   every session the stock opened 5%+ above the previous close — the
 *              days a pre-market screen would flag.
 * For each: the call with the strike nearest above the open, on the same-day
 * expiry if one exists, the nearest expiry at least a day out ("weekly"), and
 * the nearest at least 20 days out ("monthly"). Bought at the 10:00 ask. Paid
 * at expiry from the stock's close that day (intrinsic value; nothing else is
 * assumed). Also sold a day later at the bid where the next day's chain is on
 * hand. Premium and spread reported as shares of the stock price and premium.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Row = { ts: number; symbol: string; bid: number; ask: number };

const OPRA = 'data/db/opra-10am';
const OUT = 'data/weekly-cost.json';
const DRY = process.argv.includes('--dry');
const FROM = '2025-09-15', TO = '2026-09-04';
const RANDOM_PER_STOCK = 4, MAX_GAP_DAYS = 150, GAP = 0.05;
const PRICE_SCALE = 1e9;

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

const auth = 'Basic ' + Buffer.from(`${process.env.DATABENTO_KEY}:`).toString('base64');
async function db(path: string, params: Record<string, string>): Promise<Response> {
  return fetch(`https://hist.databento.com/v0/${path}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(300_000) });
}
function parseOsi(s: string): { expiry: string; right: 'C' | 'P'; strike: number } | null {
  const m = /^[A-Z.]+\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s.trim());
  return m ? { expiry: `20${m[1]}-${m[2]}-${m[3]}`, right: m[4] as 'C' | 'P', strike: Number(m[5]) / 1000 } : null;
}

/** Call quotes 09:58–10:03 ET for one underlying on one day; null when it has no options. */
async function chainAtTen(symbol: string, date: string, spend: { usd: number }): Promise<Row[] | null> {
  const path = `${OPRA}/${date}/${symbol}.json`;
  const hit = await readJson<Row[] | null | undefined>(path, undefined);
  if (hit !== undefined) return hit;
  const params = { dataset: 'OPRA.PILLAR', symbols: `${symbol}.OPT`, stype_in: 'parent', schema: 'cbbo-1m', start: new Date(nyMs(date, 598)).toISOString(), end: new Date(nyMs(date, 603)).toISOString() };
  const cost = await db('metadata.get_cost', params);
  if (cost.status === 422) { await mkdir(`${OPRA}/${date}`, { recursive: true }); await writeFile(path, 'null'); return null; }
  if (!cost.ok) throw new Error(`get_cost HTTP ${cost.status}: ${(await cost.text()).slice(0, 200)}`);
  spend.usd += Number(await cost.text());
  if (DRY) return [];
  const res = await db('timeseries.get_range', { ...params, encoding: 'csv', map_symbols: 'true' });
  if (!res.ok) throw new Error(`get_range HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const lines = (await res.text()).split('\n'), header = lines[0].split(',');
  const iTs = header.indexOf('ts_recv'), iBid = header.indexOf('bid_px_00'), iAsk = header.indexOf('ask_px_00'), iSym = header.indexOf('symbol');
  const px = (raw: string) => { const v = Number(raw) / PRICE_SCALE; return v > 0 && v < 1e6 ? v : NaN; };
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= iSym || !/C\d{8}$/.test(c[iSym].trim())) continue;
    out.push({ ts: Number(c[iTs]) / 1e6, symbol: c[iSym].trim(), bid: px(c[iBid]), ask: px(c[iAsk]) });
  }
  await mkdir(`${OPRA}/${date}`, { recursive: true });
  await writeFile(path, JSON.stringify(out));
  return out;
}

type Trade = { sample: string; date: string; symbol: string; kind: string; open: number; strike: number; expiry: string; dte: number; premium: number; premiumPctOfStock: number; spreadPctOfPremium: number; closeAtExpiry: number; payoffPctOfStock: number; netPctOfStock: number; netPctOfPremium: number };

async function main() {
  const ref = JSON.parse(await readFile('data/reference/weekly-optionable-bottom-decile.json', 'utf8'));
  const names: string[] = ref.bottom.map((s: any) => s.symbol);
  const daily = new Map<string, Daily[]>();
  for (const s of names) daily.set(s, await readJson<Daily[]>(`data/db/daily/${s}.json`, []));
  const rnd = mulberry32(11);
  const picks: { sample: string; symbol: string; date: string }[] = [];
  const gapDays: { symbol: string; date: string }[] = [];
  for (const s of names) {
    const bars = daily.get(s)!;
    const inWindow = bars.map((b, i) => ({ b, i })).filter(({ b }) => b.date >= FROM && b.date <= TO && b.open > 0);
    const shuffled = [...inWindow].sort(() => rnd() - 0.5).slice(0, RANDOM_PER_STOCK);
    for (const { b } of shuffled) picks.push({ sample: 'random', symbol: s, date: b.date });
    for (const { b, i } of inWindow) if (i > 0 && b.open / bars[i - 1].close - 1 >= GAP) gapDays.push({ symbol: s, date: b.date });
  }
  const gapPick = gapDays.length > MAX_GAP_DAYS ? [...gapDays].sort(() => rnd() - 0.5).slice(0, MAX_GAP_DAYS) : gapDays;
  for (const g of gapPick) picks.push({ sample: 'gap day (open 5%+ up)', ...g });
  console.log(`${names.length} stocks; ${picks.filter((p) => p.sample === 'random').length} random stock-days; ${gapDays.length} gap days of which ${gapPick.length} sampled`);

  const spend = { usd: 0 };
  const trades: Trade[] = [];
  let noOptions = 0, noQuote = 0, sameDayExpiries = 0, next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < picks.length) {
      const p = picks[next++];
      const rows = await chainAtTen(p.symbol, p.date, spend).catch((e) => { console.warn(`${p.date} ${p.symbol}: ${(e as Error).message}`); return undefined; });
      if (rows === undefined) continue;
      if (rows === null) { noOptions++; continue; }
      if (DRY) continue;
      const bars = daily.get(p.symbol)!;
      const i = bars.findIndex((b) => b.date === p.date);
      const open = bars[i].open;
      const byContract = new Map<string, Row[]>();
      for (const r of rows) (byContract.get(r.symbol) ?? byContract.set(r.symbol, []).get(r.symbol)!).push(r);
      const contracts = [...byContract.keys()].map((sym) => ({ sym, ...parseOsi(sym)! })).filter((c) => c.expiry && c.strike >= open);
      const dte = (exp: string) => Math.round((Date.parse(exp) - Date.parse(p.date)) / 86_400_000);
      const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
      if (expiries.some((e) => dte(e) === 0)) sameDayExpiries++;
      for (const [kind, minDays] of [['same day', 0], ['weekly', 1], ['monthly', 20]] as const) {
        const exp = expiries.find((e) => dte(e) >= minDays && (kind !== 'same day' || dte(e) === 0));
        if (!exp) continue;
        const c = contracts.filter((x) => x.expiry === exp).sort((a, b) => a.strike - b.strike)[0];
        // The 10:00 sample is stamped 10:00:00; the next one, 10:01:00, is not "at 10:00".
        const qs = byContract.get(c.sym)!.filter((q) => q.ts < nyMs(p.date, 601) && q.bid > 0 && q.ask >= q.bid).sort((a, b) => a.ts - b.ts);
        const q = qs.at(-1);
        if (!q) { noQuote++; continue; }
        const expBar = [...bars].filter((b) => b.date <= exp).at(-1);
        if (!expBar || expBar.date < p.date) continue;
        const payoff = Math.max(expBar.close - c.strike, 0);
        trades.push({ sample: p.sample, date: p.date, symbol: p.symbol, kind, open, strike: c.strike, expiry: exp, dte: dte(exp), premium: q.ask, premiumPctOfStock: q.ask / open, spreadPctOfPremium: (q.ask - q.bid) / q.ask, closeAtExpiry: expBar.close, payoffPctOfStock: payoff / open, netPctOfStock: (payoff - q.ask) / open, netPctOfPremium: payoff / q.ask - 1 });
      }
    }
  }));
  console.log(`no listed options on ${noOptions} stock-days; ${noQuote} contracts without a two-sided quote at 10:00; same-day expiries seen on ${sameDayExpiries} stock-days; OPRA spend $${spend.usd.toFixed(2)}`);
  if (DRY) return;

  console.log(`\n${'sample · expiry'.padEnd(34)}${'n'.padStart(5)}${'DTE'.padStart(5)}${'premium/stock'.padStart(15)}${'spread/prem'.padStart(13)}${'payoff/stock'.padStart(14)}${'net/stock'.padStart(11)}${'net/premium'.padStart(13)}${'paid off'.padStart(10)}${'stock 5-day up 5%+'.padStart(20)}`);
  const summary: any[] = [];
  for (const sample of ['random', 'gap day (open 5%+ up)']) for (const kind of ['same day', 'weekly', 'monthly']) {
    const ts = trades.filter((t) => t.sample === sample && t.kind === kind);
    if (!ts.length) continue;
    const row = { sample, kind, n: ts.length, medianDte: median(ts.map((t) => t.dte)), premiumPctOfStock: median(ts.map((t) => t.premiumPctOfStock)), spreadPctOfPremium: median(ts.map((t) => t.spreadPctOfPremium)), payoffPctOfStock: mean(ts.map((t) => t.payoffPctOfStock)), netPctOfStock: mean(ts.map((t) => t.netPctOfStock)), netPctOfPremium: mean(ts.map((t) => t.netPctOfPremium)), paidOff: mean(ts.map((t) => (t.netPctOfStock > 0 ? 1 : 0))), stockUp5: mean(ts.map((t) => (t.closeAtExpiry / t.open - 1 >= 0.05 ? 1 : 0))) };
    summary.push(row);
    console.log(`${`${sample} · ${kind}`.padEnd(34)}${String(row.n).padStart(5)}${String(row.medianDte).padStart(5)}${pct(row.premiumPctOfStock).padStart(15)}${pct(row.spreadPctOfPremium).padStart(13)}${pct(row.payoffPctOfStock).padStart(14)}${pct(row.netPctOfStock).padStart(11)}${pct(row.netPctOfPremium).padStart(13)}${pct(row.paidOff).padStart(10)}${pct(row.stockUp5).padStart(20)}`);
  }
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), universe: 'weekly-optionable stocks, bottom decile by market cap (2026-09-14)', window: [FROM, TO], noOptions, noQuote, sameDayExpiries, spend: +spend.usd.toFixed(2), summary, trades }));
  console.log(`\nWrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
