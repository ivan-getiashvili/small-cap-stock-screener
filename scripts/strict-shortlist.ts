/**
 * The strict shortlist — catalyst, float, relative volume, day one — replayed over
 * two years, and whether it changes any result. -> data/strict-shortlist.json
 *
 * Run:  node --experimental-strip-types scripts/strict-shortlist.ts
 * Needs SEC_USER_AGENT and the result files of early-flags, high-timing and playbook.
 * Free: everything comes from SEC EDGAR (cached under data/db/edgar) and local bars.
 *
 * Every test so far used the broad gate (up 10%+, 50k+ shares, $2–$20). The live
 * shortlist adds a news catalyst and a float under 10M, and the source also
 * wants relative volume 5× and "day one, not day two or three". This script
 * decides those four things for each of the 4,257 stock-days the 08:45 gate
 * flagged, point-in-time:
 *
 *   catalyst  an 8-K (or 6-K for foreign filers) ACCEPTED by EDGAR between 15:30 ET
 *             the previous session and 08:45 ET that morning. Press releases
 *             cannot be replayed, so this undercounts catalysts — a subset, never
 *             an inflation.
 *   float     shares outstanding from the latest 10-Q/10-K FILED before that
 *             morning (dei:EntityCommonStockSharesOutstanding). An upper bound on
 *             float, as in the live scan. Unknown counts as a fail.
 *   rvol      pre-market shares by 08:45 ÷ average daily volume of the prior 50
 *             sessions.
 *   day one   fewer than two consecutive up closes before this morning, and no
 *             50%+ run over the previous five sessions.
 *
 * Then the same outcomes as before — the holds, the +20% target, their
 * playbook — are read back for each subset from the earlier result files.
 * Nothing is recomputed, so a subset cannot be flattered by a different method.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const EDGAR = 'data/db/edgar';
const OUT = 'data/strict-shortlist.json';
const UA = process.env.SEC_USER_AGENT;
if (!UA) throw new Error('SEC_USER_AGENT is not set — put it in .env.local');

type Daily = { date: string; open: number; high: number; low: number; close: number; volume: number };

function nyOffsetMin(date: string): number {
  const h = Number(new Date(`${date}T16:00:00Z`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return (16 - h) * 60;
}
const nyMs = (date: string, minute: number) => Date.parse(`${date}T00:00:00Z`) + (minute + nyOffsetMin(date)) * 60_000;
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// EDGAR asks for no more than 10 requests a second; this keeps to about 8.
let nextSlot = 0;
async function edgar(url: string): Promise<any | null> {
  const now = Date.now();
  nextSlot = Math.max(nextSlot, now) + 125;
  await new Promise((r) => setTimeout(r, nextSlot - now));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA!, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 403) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
  return null;
}
async function cached(path: string, fetcher: () => Promise<any | null>): Promise<any | null> {
  const hit = await readJson<any>(path, undefined);
  if (hit !== undefined) return hit;
  const v = await fetcher();
  await writeFile(path, JSON.stringify(v ?? null));
  return v;
}

/** Acceptance times of every 8-K/6-K on file, reaching back far enough for `earliest`. */
async function currentReports(cik: string, earliest: string): Promise<{ form: string; accepted: number }[]> {
  const out: { form: string; accepted: number }[] = [];
  const take = (r: any) => { if (r?.form) for (let k = 0; k < r.form.length; k++) if (/^(8-K|6-K)(\/A)?$/.test(r.form[k])) out.push({ form: r.form[k], accepted: Date.parse(r.acceptanceDateTime?.[k] ?? '') }); };
  const sub = await cached(`${EDGAR}/submissions/CIK${cik}.json`, () => edgar(`https://data.sec.gov/submissions/CIK${cik}.json`));
  if (!sub) return out;
  take(sub.filings?.recent);
  const oldest = sub.filings?.recent?.filingDate?.at(-1) ?? '9999';
  if (oldest > earliest) for (const f of sub.filings?.files ?? []) {
    if (f.filingTo < earliest) continue;
    const page = await cached(`${EDGAR}/submissions/${f.name}`, () => edgar(`https://data.sec.gov/submissions/${f.name}`));
    take(page);
  }
  return out;
}

/** Shares outstanding as reported, with the date each figure was filed. */
async function sharesHistory(cik: string): Promise<{ end: string; filed: string; val: number }[]> {
  const j = await cached(`${EDGAR}/shares/CIK${cik}.json`, () => edgar(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`));
  return (j?.units?.shares ?? []).filter((u: any) => u?.val > 0 && u?.filed).map((u: any) => ({ end: String(u.end), filed: String(u.filed), val: Number(u.val) }));
}

type StockDay = {
  date: string; symbol: string; prev: string; preMarketShares: number;
  catalyst8K: boolean; catalyst: boolean; sharesOut: number | null; rvol: number | null; dayOne: boolean;
};

function ci95ByDay(items: { date: string; v: number }[]): [number, number] {
  const byDate = new Map<string, number[]>();
  for (const it of items) (byDate.get(it.date) ?? byDate.set(it.date, []).get(it.date)!).push(it.v);
  const days = [...byDate.values()], rnd = mulberry32(1), means: number[] = [];
  for (let i = 0; i < 2000; i++) { let s = 0, c = 0; for (let j = 0; j < days.length; j++) for (const x of days[Math.floor(rnd() * days.length)]) { s += x; c++; } means.push(s / c); }
  means.sort((a, b) => a - b);
  return [means[50], means[1949]];
}

async function main() {
  await mkdir(`${EDGAR}/submissions`, { recursive: true });
  await mkdir(`${EDGAR}/shares`, { recursive: true });
  const flags = (JSON.parse(await readFile('data/early-flags.json', 'utf8')).trades as any[]).filter((t) => t.flag === '08:45');
  const timing = new Map<string, any>((JSON.parse(await readFile('data/high-timing.json', 'utf8')).rows as any[]).map((r) => [`${r.date} ${r.symbol}`, r]));
  const playbook = JSON.parse(await readFile('data/playbook.json', 'utf8')).trades as any[];
  const aapl = await readJson<Daily[]>('data/db/daily/AAPL.json', []);
  const prevOf = new Map(aapl.slice(1).map((b, i) => [b.date, aapl[i].date]));

  const tickers = await cached(`${EDGAR}/company_tickers.json`, () => edgar('https://www.sec.gov/files/company_tickers.json'));
  const cikOf = new Map<string, string>();
  for (const row of Object.values<any>(tickers ?? {})) if (row?.ticker) cikOf.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));

  // EDGAR, once per symbol.
  const symbols = [...new Set(flags.map((t) => t.symbol as string))].sort();
  const earliestBySymbol = new Map<string, string>();
  for (const t of flags) if (!earliestBySymbol.has(t.symbol) || t.date < earliestBySymbol.get(t.symbol)!) earliestBySymbol.set(t.symbol, prevOf.get(t.date) ?? t.date);
  const reports = new Map<string, { form: string; accepted: number }[]>(), shares = new Map<string, { end: string; filed: string; val: number }[]>();
  let done = 0, noCik = 0;
  const queue = [...symbols];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      const cik = cikOf.get(s);
      if (!cik) { noCik++; continue; }
      reports.set(s, await currentReports(cik, earliestBySymbol.get(s)!).catch(() => []));
      shares.set(s, await sharesHistory(cik).catch(() => []));
      if (++done % 200 === 0) console.log(`  EDGAR: ${done}/${symbols.length} symbols`);
    }
  }));
  console.log(`${symbols.length} symbols; ${noCik} without a CIK on EDGAR (no catalyst or float possible for them)`);

  // Decide the four things for each stock-day.
  const dailyCache = new Map<string, Daily[]>();
  const rows: StockDay[] = [];
  for (const t of flags) {
    const prev = prevOf.get(t.date);
    if (!prev) continue;
    const from = nyMs(prev, 930), to = nyMs(t.date, 525);
    const rep = reports.get(t.symbol) ?? [];
    const catalyst8K = rep.some((r) => r.form.startsWith('8-K') && r.accepted >= from && r.accepted <= to);
    const catalyst = catalyst8K || rep.some((r) => r.accepted >= from && r.accepted <= to);
    const so = (shares.get(t.symbol) ?? []).filter((u) => u.filed < t.date).sort((a, b) => a.filed.localeCompare(b.filed) || a.end.localeCompare(b.end)).pop();
    if (!dailyCache.has(t.symbol)) dailyCache.set(t.symbol, await readJson<Daily[]>(`data/db/daily/${t.symbol}.json`, []));
    const bars = dailyCache.get(t.symbol)!;
    const i = bars.findIndex((b) => b.date === t.date);
    const prior = i > 0 ? bars.slice(Math.max(0, i - 50), i) : [];
    const avg = prior.length >= 10 ? mean(prior.map((b) => b.volume)) : NaN;
    const closes = i > 0 ? bars.slice(Math.max(0, i - 6), i).map((b) => b.close) : [];
    let daysUp = 0;
    for (let k = closes.length - 1; k > 0; k--) { if (closes[k] > closes[k - 1]) daysUp++; else break; }
    const run = closes.length >= 2 ? closes[closes.length - 1] / closes[0] - 1 : 0;
    rows.push({ date: t.date, symbol: t.symbol, prev, preMarketShares: t.sharesAtFlag, catalyst8K, catalyst, sharesOut: so?.val ?? null, rvol: avg > 0 ? t.sharesAtFlag / avg : null, dayOne: daysUp < 2 && run < 0.5 });
  }

  const subsets: [string, (r: StockDay) => boolean][] = [
    ['all flagged at 08:45 (broad gate)', () => true],
    ['+ 8-K catalyst', (r) => r.catalyst8K],
    ['+ 8-K or 6-K catalyst', (r) => r.catalyst],
    ['+ float < 10M', (r) => r.sharesOut !== null && r.sharesOut < 10e6],
    ['+ float < 20M', (r) => r.sharesOut !== null && r.sharesOut < 20e6],
    ['+ relative volume ≥ 5×', (r) => r.rvol !== null && r.rvol >= 5],
    ['+ day one', (r) => r.dayOne],
    ['STRICT: catalyst + float < 10M', (r) => r.catalyst && r.sharesOut !== null && r.sharesOut < 10e6],
    ['strict + rvol ≥ 5×', (r) => r.catalyst && r.sharesOut !== null && r.sharesOut < 10e6 && r.rvol !== null && r.rvol >= 5],
    ['strict + day one', (r) => r.catalyst && r.sharesOut !== null && r.sharesOut < 10e6 && r.dayOne],
    ['catalyst + float < 20M + day one', (r) => r.catalyst && r.sharesOut !== null && r.sharesOut < 20e6 && r.dayOne],
  ];

  const pct = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
  const R = (x: number) => (Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const results: any[] = [];
  console.log(`\n${'subset'.padEnd(36)}${'days'.padStart(6)}${'ran 20%+'.padStart(9)}${'→open'.padStart(8)}${'→close'.padStart(8)}${'+20%→noon'.padStart(11)}${'+20%→close'.padStart(12)}${'  95% range (+20%→close)'.padEnd(26)}${'gap&go R'.padStart(9)}${'pullback R'.padStart(11)}`);
  for (const [name, keep] of subsets) {
    const sel = rows.filter(keep);
    if (!sel.length) { console.log(`${name.padEnd(36)}${'0'.padStart(6)}`); continue; }
    const keys = new Set(sel.map((r) => `${r.date} ${r.symbol}`));
    const fl = flags.filter((t) => keys.has(`${t.date} ${t.symbol}`));
    const tm = sel.map((r) => timing.get(`${r.date} ${r.symbol}`)).filter(Boolean);
    const gg = playbook.filter((t) => t.setup === 'gap and go: first candle high' && t.mode === 'all out at 2R' && keys.has(`${t.date} ${t.symbol}`));
    const pb = playbook.filter((t) => t.setup === 'first pullback' && t.mode === 'all out at 2R' && keys.has(`${t.date} ${t.symbol}`));
    const row = {
      subset: name, stockDays: sel.length, sessions: new Set(sel.map((r) => r.date)).size,
      ran20: mean(tm.map((r) => (r.highPct >= 0.2 ? 1 : 0))),
      toOpen: mean(fl.map((t) => t.ret.open)), toClose: mean(fl.map((t) => t.ret.close)),
      target20Noon: mean(tm.map((r) => r.ret['+20% target → noon'])), target20Close: mean(tm.map((r) => r.ret['+20% target → close'])),
      target20CloseCi95: tm.length ? ci95ByDay(tm.map((r) => ({ date: r.date, v: r.ret['+20% target → close'] }))) : [NaN, NaN],
      target20CloseWin: mean(tm.map((r) => (r.ret['+20% target → close'] > 0 ? 1 : 0))),
      gapAndGo: { trades: gg.length, meanR: mean(gg.map((t) => t.rNet)), winRate: mean(gg.map((t) => (t.rNet > 0 ? 1 : 0))) },
      pullback: { trades: pb.length, meanR: mean(pb.map((t) => t.rNet)), winRate: mean(pb.map((t) => (t.rNet > 0 ? 1 : 0))) },
    };
    results.push(row);
    console.log(`${name.padEnd(36)}${String(row.stockDays).padStart(6)}${pct(row.ran20).padStart(9)}${pct(row.toOpen).padStart(8)}${pct(row.toClose).padStart(8)}${pct(row.target20Noon).padStart(11)}${pct(row.target20Close).padStart(12)}  ${`${pct(row.target20CloseCi95[0])} … ${pct(row.target20CloseCi95[1])}`.padEnd(24)}${`${R(row.gapAndGo.meanR)} (${gg.length})`.padStart(9)}${`${R(row.pullback.meanR)} (${pb.length})`.padStart(11)}`);
  }
  const known = rows.filter((r) => r.sharesOut !== null).length;
  console.log(`\nFloat known (a share count filed before the morning) for ${known}/${rows.length} stock-days; catalyst found for ${rows.filter((r) => r.catalyst).length} (8-K only: ${rows.filter((r) => r.catalyst8K).length}); day one: ${rows.filter((r) => r.dayOne).length}.`);
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results, rows }));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
