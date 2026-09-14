/**
 * Replay past mornings into the track record -> data/history.json (source: "replay")
 *
 * Run:  node --experimental-strip-types scripts/backfill-history.ts --dry
 *       node --experimental-strip-types scripts/backfill-history.ts [--sessions=20]
 * Needs DATABENTO_KEY, SEC_USER_AGENT and the local daily bar cache (data/db/daily).
 *
 * The rules that keep this honest — each one exists because the easy version
 * would make the track record show big moves by construction:
 *
 * 1. EVERY small cap priced $1–$25 at the previous close is replayed, not the
 *    days already known to have moved. Selecting on the outcome is exactly how a
 *    record ends up full of runners.
 * 2. Pre-market is replayed from 1-minute bars up to 08:45 ET and no further.
 * 3. A catalyst only counts if its 8-K was ACCEPTED between 15:30 ET on the
 *    previous session and 08:45 ET that morning (EDGAR records acceptance to the
 *    second). Press releases cannot be replayed — the wire feeds keep only their
 *    latest 20 items — so a replayed list is a subset of what live would find.
 * 4. XNAS.BASIC carries roughly 48–83% of consolidated volume, so the 50k
 *    pre-market volume gate is applied to an undercount: stricter, never looser.
 * 5. Performance comes from consolidated daily bars for that session.
 *
 * Known leak, stated rather than hidden: float uses today's filed share count,
 * because historical share counts are not available per morning.
 */
import { readFile, readdir } from 'node:fs/promises';
import { streamBars, getCost, batches, MINUTE_DATASET } from '../lib/sources/databento.ts';
import { getTickerToCik, getSharesOutstanding, floatFromSharesOutstanding } from '../lib/sources/sec.ts';
import { getSubmissions, describeItems, getCompanyProfile } from '../lib/sources/news.ts';
import { loadHistory, saveHistory, recordScan, fillPerformance } from '../lib/history.ts';
import type { Bar } from '../lib/types.ts';

const DAILY = 'data/db/daily';
const DRY = process.argv.includes('--dry');
const SESSIONS = Number(process.argv.find((a) => a.startsWith('--sessions='))?.split('=')[1] ?? '20');

const BAND = { min: 1, max: 25 };
const GATE = {
  minPreMarketChangePct: 10, minPreMarketVolume: 50_000, goodPreMarketVolume: 150_000,
  priceMin: 2, priceMax: 20, floatIdeal: 10_000_000,
};

/** A New York wall-clock time on a date, as UTC ms (handles daylight saving). */
function nyToUtcMs(dateIso: string, hh: number, mm: number): number {
  const noon = new Date(`${dateIso}T12:00:00Z`);
  const nyHour = Number(noon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const [y, m, d] = dateIso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh + (12 - nyHour), mm);
}

async function loadDaily(): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const f of await readdir(DAILY)) {
    if (!f.endsWith('.json')) continue;
    try {
      const bars: Bar[] = JSON.parse(await readFile(`${DAILY}/${f}`, 'utf8'));
      if (bars.length) out.set(f.replace('.json', ''), bars.slice(-320));   // enough for 20 sessions + a year of spikes
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const daily = await loadDaily();
  const ref = daily.get('AAPL');
  if (!ref) throw new Error('no AAPL daily bars in the cache');
  const sessions = ref.map((b) => b.date).slice(-(SESSIONS + 1));      // +1: each needs its previous session
  console.log(`Loaded ${daily.size} symbols in ${((Date.now() - t0) / 1000).toFixed(0)}s; replaying ${sessions.length - 1} sessions ${sessions[1]} → ${sessions.at(-1)}`);

  const history = await loadHistory();
  const cikMap = await getTickerToCik();
  const sharesCache = new Map<string, Awaited<ReturnType<typeof getSharesOutstanding>>>();
  const profileCache = new Map<string, Awaited<ReturnType<typeof getCompanyProfile>>>();
  let totalCost = 0;

  for (let s = 1; s < sessions.length; s++) {
    const prev = sessions[s - 1], date = sessions[s];
    if (history.days[date]?.source === 'live') { console.log(`${date}: live record exists — not replaced`); continue; }

    // Rule 1: the whole band, by the previous close — never by what happened next.
    const band: string[] = [];
    for (const [sym, bars] of daily) {
      const p = bars.find((b) => b.date === prev);
      if (p && p.close >= BAND.min && p.close <= BAND.max && bars.some((b) => b.date === date)) band.push(sym);
    }
    const start = new Date(nyToUtcMs(date, 4, 0)).toISOString();
    const end = new Date(nyToUtcMs(date, 8, 46)).toISOString();

    if (DRY) {
      let c = 0;
      for (const b of batches(band)) c += await getCost({ dataset: MINUTE_DATASET, symbols: b.join(','), schema: 'ohlcv-1m', start, end });
      totalCost += c;
      console.log(`${date}: ${band.length} symbols in band, pre-market pull $${c.toFixed(3)}`);
      continue;
    }

    // Rule 2: replay pre-market up to 08:45 ET.
    const state = new Map<string, { last: number; vol: number }>();
    for (const b of batches(band)) {
      for await (const bar of streamBars({ dataset: MINUTE_DATASET, symbols: b, schema: 'ohlcv-1m', start, end })) {
        const st = state.get(bar.symbol) ?? { last: 0, vol: 0 };
        st.last = bar.close; st.vol += bar.volume;
        state.set(bar.symbol, st);
      }
    }

    const rows: any[] = [];
    for (const [sym, st] of state) {
      const bars = daily.get(sym)!;
      const i = bars.findIndex((b) => b.date === date);
      const pc = bars[i - 1]?.date === prev ? bars[i - 1].close : null;
      if (!pc || !(st.last > 0)) continue;
      const chg = ((st.last - pc) / pc) * 100;
      if (chg < GATE.minPreMarketChangePct - 5) continue;

      const cik = cikMap.get(sym) ?? null;

      // Rule 3: only filings accepted before 08:45 ET that morning.
      let catalyst: any = { found: false, kind: null, headline: null, subject: null, date: null };
      if (cik) {
        const sub = await getSubmissions(cik).catch(() => null);
        const r = sub?.filings?.recent;
        const from = nyToUtcMs(prev, 15, 30), to = nyToUtcMs(date, 8, 45);
        if (r?.form) for (let k = 0; k < r.form.length; k++) {
          if (r.form[k] !== '8-K' && r.form[k] !== '8-K/A') continue;
          const acc = Date.parse(r.acceptanceDateTime?.[k] ?? '');
          if (!(acc >= from && acc <= to)) continue;
          const subject = describeItems(r.items?.[k]);
          catalyst = { found: true, kind: '8-K', headline: subject ?? '8-K current report', subject, date: r.filingDate[k] };
          break;
        }
      }

      if (!sharesCache.has(sym)) sharesCache.set(sym, await getSharesOutstanding(sym).catch(() => null));
      const so = sharesCache.get(sym);
      const float = floatFromSharesOutstanding(so?.shares ?? null, so?.asOf ?? date);
      if (cik && !profileCache.has(cik)) profileCache.set(cik, await getCompanyProfile(cik).catch(() => null));
      const profile = cik ? profileCache.get(cik) : null;

      const prior = bars.slice(Math.max(0, i - 50), i);
      const a50 = prior.length >= 10 ? prior.reduce((a, b) => a + b.volume, 0) / prior.length : null;
      const closes6 = bars.slice(Math.max(0, i - 6), i).map((b) => b.close);
      let daysUp = 0;
      for (let k = closes6.length - 1; k > 0; k--) { if (closes6[k] > closes6[k - 1]) daysUp++; else break; }
      const priorRun = closes6.length >= 2 ? ((closes6.at(-1)! - closes6[0]) / closes6[0]) * 100 : null;

      const checks = [
        { name: `Up ≥${GATE.minPreMarketChangePct}% pre-market`, ok: chg >= GATE.minPreMarketChangePct, detail: `${chg.toFixed(1)}%` },
        { name: `Pre-market volume ≥${GATE.minPreMarketVolume / 1000}k`, ok: st.vol >= GATE.minPreMarketVolume, detail: Math.round(st.vol).toLocaleString() },
        { name: 'News catalyst', ok: catalyst.found, detail: catalyst.found ? '8-K' : 'none found' },
        { name: `Price $${GATE.priceMin}–$${GATE.priceMax}`, ok: st.last >= GATE.priceMin && st.last <= GATE.priceMax, detail: `$${st.last.toFixed(2)}` },
        { name: `Float <${GATE.floatIdeal / 1e6}M`, ok: !!float && float.floatShares < GATE.floatIdeal, detail: float ? `${(float.floatShares / 1e6).toFixed(1)}M` : 'unknown' },
      ];
      rows.push({
        symbol: sym, name: sym, legalName: profile?.name ?? null, business: profile?.business ?? null,
        preMarketPrice: st.last, preMarketChangePct: chg, prevClose: pc, preMarketVolume: st.vol,
        relVolume: a50 ? st.vol / a50 : null, float: float ? { shares: float.floatShares } : null,
        catalyst, extended: daysUp >= 2 || (priorRun !== null && priorRun >= 50), checks,
        passed: checks.filter((c) => c.ok).length,
      });
    }
    rows.sort((a, b) => b.passed - a.passed || b.preMarketChangePct - a.preMarketChangePct);
    const payload = { shortlist: rows.filter((r) => r.passed === 5).slice(0, 8), watchlist: rows.filter((r) => r.passed === 4).slice(0, 8) };

    delete history.days[date];                                     // replace an older replay of the same date
    recordScan(history, date, payload, 'replay', new Date(nyToUtcMs(date, 8, 45)).toISOString());
    await fillPerformance(history, async (sym) => daily.get(sym) ?? [], 1000);
    await saveHistory(history);

    const day = history.days[date];
    const fmt = (n: any) => `${n.symbol} +${n.preMarketChangePct.toFixed(0)}%→${n.performance ? `hi ${n.performance.openToHighPct >= 0 ? '+' : ''}${n.performance.openToHighPct.toFixed(0)}% cl ${n.performance.openToClosePct >= 0 ? '+' : ''}${n.performance.openToClosePct.toFixed(0)}%` : 'unscored'}`;
    console.log(`${date}: ${band.length} in band, ${state.size} traded pre-market, ${rows.length} movers → ` +
      `shortlist [${(day?.names ?? []).filter((n) => n.list === 'shortlist').map(fmt).join(', ')}] ` +
      `watch ${(day?.names ?? []).filter((n) => n.list === 'watchlist').length}`);
  }
  if (DRY) console.log(`\nEstimated Databento cost for the pre-market pulls: $${totalCost.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
