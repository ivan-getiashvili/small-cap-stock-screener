/**
 * The pre-market shortlist -> data/premarket.json, and today's page in data/history.json
 *
 * Run:  npm run premarket        (CI sweeps it every 20 minutes through pre-market)
 *
 * A handful of tickers to look at before the bell, each with the evidence that
 * put it there. The trading decision is yours.
 *
 * HOW NAMES ARE FOUND — and why it is shaped this way:
 *
 * Nasdaq publishes no free live pre-market list: during pre-market its bulk
 * screener still shows the previous close for all 6,090 stocks, and its movers
 * lists are stamped with the previous session. Live pre-market prices exist only
 * one symbol at a time, and asking about all ~3,400 small caps got us blocked.
 *
 * So discovery starts from catalysts (lib/sources/discovery.ts): overnight 8-K
 * filings, same-morning press releases, and yesterday's biggest gainers. Only
 * those symbols get a live quote — a few dozen requests, not thousands. Every
 * shortlist name needs a catalyst anyway, so this applies that criterion first
 * instead of last.
 *
 * AFTER THE BELL the morning's final pre-market list is kept rather than
 * re-scanned: the scan is about pre-market, and re-scanning during the session
 * would spend requests to produce a list nobody should act on as "pre-market".
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getUniverse, getBars } from '../lib/sources/nasdaq.ts';
import { getPreMarketQuotes, getMarketStatus } from '../lib/sources/premarket.ts';
import { getTickerToCik, getFloat, makePriceLookup, floatFromSharesOutstanding, getSharesOutstanding } from '../lib/sources/sec.ts';
import { findCatalyst, getCompanyProfile, classify } from '../lib/sources/news.ts';
import { edgarLeads, wireLeads, type Lead } from '../lib/sources/discovery.ts';
import { loadHistory, saveHistory, recordScan, fillPerformance, nyToday } from '../lib/history.ts';

/** Which names are worth a live quote at all. Deliberately generous. */
const UNIVERSE = { priceMin: 1, priceMax: 25, maxMarketCap: 2e9 };
/** Hard ceiling on live lookups per scan — the endpoint has blocked us before. */
const MAX_LOOKUPS = 150;
/** Yesterday's runners worth re-checking, and how big a move qualifies. */
const PRIOR_GAINERS = 25;
const PRIOR_GAINER_MIN_PCT = 15;
/** How many live movers get the expensive detail pass (float, catalyst, profile). */
const INVESTIGATE = 30;
/** The gate for appearing on the shortlist at all. */
const GATE = {
  minPreMarketChangePct: 10,   // "up at least 10%" / "10%+ pre-market"
  minPreMarketVolume: 50_000,  // under 50k pre-market is low quality
  goodPreMarketVolume: 150_000,// over 150k is high quality
  priceMin: 2, priceMax: 20,
  floatIdeal: 10_000_000,      // "under 10 million shares"
  floatStretch: 20_000_000,
};
const SHORTLIST_MAX = 8;

async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/** The last few closes per symbol, to tell a fresh move from a multi-day run. */
async function closeHistory(): Promise<Map<string, number[]>> {
  const j = await readJson('data/closes.json');
  return new Map(Object.entries(j ?? {})) as Map<string, number[]>;
}

/** Consecutive rising sessions ending at the latest close. */
function runLength(closes: number[] | undefined): number {
  if (!closes || closes.length < 2) return 0;
  let n = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) n++; else break;
  }
  return n;
}

/** How far the stock has already travelled over the stored window, in percent. */
function priorRunPct(closes: number[] | undefined): number | null {
  if (!closes || closes.length < 2) return null;
  const first = closes[0], last = closes[closes.length - 1];
  return first > 0 ? ((last - first) / first) * 100 : null;
}

/** Closing prices recorded by the post-close job. */
async function prevCloses(): Promise<Map<string, number>> {
  const j = await readJson('data/prevclose.json');
  return new Map(Object.entries(j ?? {})) as Map<string, number>;
}

/** 50-day average volume and best prior spike, from the committed digest. */
async function stats(): Promise<{ avg: Map<string, number>; spike: Map<string, number | null> }> {
  const digest: Record<string, [number, number | null]> = (await readJson('data/stats.json')) ?? {};
  const avg = new Map<string, number>(), spike = new Map<string, number | null>();
  for (const [sym, [a, s]] of Object.entries(digest)) { avg.set(sym, a); spike.set(sym, s); }
  return { avg, spike };
}

/** A wall-clock time in New York on a given date, as UTC milliseconds. */
function nyToUtcMs(dateIso: string, hh: number, mm: number): number {
  const noonUtc = new Date(`${dateIso}T12:00:00Z`);
  const nyHour = Number(noonUtc.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const offset = 12 - nyHour;                       // 4 in summer, 5 in winter
  const [y, m, d] = dateIso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh + offset, mm);
}

const nyDateOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function main() {
  const startedAt = new Date().toISOString();
  const status = await getMarketStatus();
  const statusText = status?.status ?? 'unknown';
  const inPreMarket = /pre[\s-]?market/i.test(statusText);
  const today = nyToday();
  console.log(`Nasdaq says: ${statusText}`);

  const history = await loadHistory();

  // After the bell, keep this morning's final pre-market list instead of re-scanning.
  if (!inPreMarket) {
    const existing = await readJson('data/premarket.json');
    if (existing?.discovery && nyDateOf(existing.generatedAt) === today) {
      existing.marketStatus = statusText;
      existing.frozenAfterPreMarket = true;
      await writeFile('data/premarket.json', JSON.stringify(existing, null, 2));
      const filled = await fillPerformance(history, getBars);
      await saveHistory(history);
      console.log(`Not pre-market — keeping this morning's final list ` +
        `(${existing.shortlist.length} shortlist, ${existing.watchlist.length} watchlist). History: scored ${filled}.`);
      return;
    }
  }

  // --- The universe, and yesterday's closes ---------------------------------
  const { quotes: universe, asOf } = await getUniverse();
  const byTicker = new Map(universe.map((q) => [q.symbol, q]));
  const { avg, spike } = await stats();
  const prev = await prevCloses();
  const closes = await closeHistory();

  // During pre-market the bulk feed still carries the previous close (verified:
  // all 6,090 prices equal it). Prefer the close we stored; fall back to the feed.
  const priorClose = (s: string): number | null => prev.get(s) ?? byTicker.get(s)?.price ?? null;
  const inBand = (s: string): boolean => {
    const q = byTicker.get(s), pc = priorClose(s);
    return !!q && pc !== null && pc >= UNIVERSE.priceMin && pc <= UNIVERSE.priceMax &&
      (q.marketCap === null || q.marketCap <= UNIVERSE.maxMarketCap);
  };
  const smallCapsInBand = universe.filter((q) => inBand(q.symbol)).length;

  // Nasdaq's own "as of" label cannot be trusted: on 2026-09-14 one variant of
  // its screener said "Last price as of Aug 19, 2026" while another said Sep 11.
  // The last completed daily bar of a heavily traded stock is a fact, so the
  // previous session — which sets the catalyst window below — comes from that.
  const refBars = await getBars('AAPL', 14).catch(() => []);
  const prevSession = refBars.map((b) => b.date).filter((d) => d < today).pop() ?? asOf ?? today;
  if (asOf && asOf !== prevSession) console.log(`  (Nasdaq labels the feed "${asOf}"; its last completed session is ${prevSession})`);
  console.log(`Universe ${universe.length}, ${smallCapsInBand} small caps in band, previous session ${prevSession}`);

  // --- Discovery: which symbols have a reason to move -----------------------
  // From half an hour before the previous close: releases timed for the close
  // move the stock the next morning.
  const since = nyToUtcMs(prevSession, 15, 30);
  const [edgar, wires] = await Promise.all([
    edgarLeads(since).catch(() => ({ leads: [] as Lead[], filings: 0, ok: false })),
    wireLeads(since).catch(() => ({ leads: [] as Lead[], feeds: [] })),
  ]);
  const gainers: Lead[] = universe
    .filter((q) => inBand(q.symbol) && q.changePct >= PRIOR_GAINER_MIN_PCT)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, PRIOR_GAINERS)
    .map((q) => ({ symbol: q.symbol, source: 'prior-session gainer', at: null, headline: null, subject: null }));

  const leadsBySymbol = new Map<string, Lead[]>();
  for (const lead of [...wires.leads, ...edgar.leads, ...gainers]) {
    if (!inBand(lead.symbol)) continue;
    if (!leadsBySymbol.has(lead.symbol)) leadsBySymbol.set(lead.symbol, []);
    leadsBySymbol.get(lead.symbol)!.push(lead);
  }
  // News-backed names first, so the lookup ceiling never crowds them out.
  const newsBacked = (s: string) => leadsBySymbol.get(s)!.some((l) => l.source !== 'prior-session gainer');
  const candidates = [...leadsBySymbol.keys()]
    .sort((a, b) => Number(newsBacked(b)) - Number(newsBacked(a)))
    .slice(0, MAX_LOOKUPS);
  const count = (src: string) => [...leadsBySymbol.values()].filter((ls) => ls.some((l) => l.source === src)).length;
  console.log(`Discovery since ${new Date(since).toISOString()}: ` +
    `${edgar.filings} 8-Ks${edgar.ok ? '' : ' (feed failed)'} -> ${count('8-K')} in band, ` +
    `wires -> ${count('PR Newswire') + count('GlobeNewswire')}, prior gainers -> ${count('prior-session gainer')}; ` +
    `${candidates.length} to quote`);
  for (const f of wires.feeds) console.log(`  ${f.name.padEnd(13)} ${f.ok ? 'ok' : 'FAILED'}  ${f.inWindow}/${f.items} items in window`);

  // --- Live quotes for the candidates only ----------------------------------
  const { quotes: live, stats: fetchStats } = await getPreMarketQuotes(candidates, 3);
  const answerRate = fetchStats.requested ? (fetchStats.answered / fetchStats.requested) * 100 : 0;
  const liveQuotes = [...live.values()].filter((q) => q.live && q.price !== null && q.price > 0);
  const feedIsLive = inPreMarket && liveQuotes.length > 0;
  console.log(`  ${fetchStats.answered}/${fetchStats.requested} answered (${answerRate.toFixed(0)}%), ` +
    `${liveQuotes.length} with a live print today`);
  if (fetchStats.requested && answerRate < 50) {
    console.warn(`  ! only ${answerRate.toFixed(0)}% answered — treat this scan as unreliable`);
  }

  // Measure each move against the stored close. If Nasdaq's own change disagrees
  // by more than two points, our close is stale (a split, a missed snapshot) —
  // trust Nasdaq's figure for that name rather than report a phantom move.
  const movers = liveQuotes
    .map((q) => {
      let pc = priorClose(q.symbol)!;
      let chg = ((q.price! - pc) / pc) * 100;
      let reconciled = false;
      if (q.nasdaqChangePct !== null && Math.abs(chg - q.nasdaqChangePct) > 2) {
        chg = q.nasdaqChangePct;
        pc = q.price! / (1 + chg / 100);
        reconciled = true;
      }
      return { q, pc, chg, reconciled };
    })
    .filter((m) => m.chg >= GATE.minPreMarketChangePct - 5)
    .sort((a, b) => b.chg - a.chg)
    .slice(0, INVESTIGATE);
  console.log(`  ${movers.length} moving enough for the detail pass`);

  const cikMap = await getTickerToCik().catch(() => new Map<string, string>());
  const rows: any[] = [];

  for (const { q, pc, chg, reconciled } of movers) {
    const base = byTicker.get(q.symbol);
    const price = q.price!;
    const cik = cikMap.get(q.symbol) ?? null;

    const so = await getSharesOutstanding(q.symbol).catch(() => null);
    const sharesOut = so?.shares ?? base?.sharesOutstanding ?? null;

    // A filed public float is best; the bar cache it needs exists only locally,
    // so CI falls back to shares outstanding and labels it as an upper bound.
    let float = null;
    try {
      const bars: any[] = JSON.parse(await readFile(`data/db/daily/${q.symbol}.json`, 'utf8')).slice(-400);
      const sec = cik ? await getFloat(q.symbol, makePriceLookup(bars)).catch(() => null) : null;
      if (sec && sharesOut && sec.floatShares / sharesOut >= 0.05 && sec.floatShares <= sharesOut) float = sec;
    } catch { /* no local bar cache */ }
    float ??= floatFromSharesOutstanding(sharesOut, so?.asOf ?? today);

    // Catalyst: a same-morning press release beats a lagging filing.
    const leads = leadsBySymbol.get(q.symbol) ?? [];
    const wire = leads.find((l) => l.source === 'PR Newswire' || l.source === 'GlobeNewswire');
    let catalyst = await findCatalyst(q.symbol, cik, today);
    if (wire && (!catalyst.found || catalyst.kind === '8-K')) {
      catalyst = { found: true, kind: 'news', headline: wire.headline, subject: wire.subject ?? classify(wire.headline ?? ''), date: (wire.at ?? '').slice(0, 10) || today };
    }

    const pmVol = q.volume;
    const a50 = avg.get(q.symbol) ?? null;
    const relVol = pmVol && a50 ? pmVol / a50 : null;
    const rotation = pmVol && float ? pmVol / float.floatShares : null;
    const profile = cik ? await getCompanyProfile(cik).catch(() => null) : null;
    const hist = closes.get(q.symbol);
    const daysUp = runLength(hist);
    const priorRun = priorRunPct(hist);
    const extended = daysUp >= 2 || (priorRun !== null && priorRun >= 50);
    const marketCap = sharesOut ? sharesOut * price : (base?.marketCap ?? null);

    const checks = [
      { name: `Up ≥${GATE.minPreMarketChangePct}% pre-market`, ok: chg >= GATE.minPreMarketChangePct, detail: `${chg.toFixed(1)}%` },
      { name: `Pre-market volume ≥${GATE.minPreMarketVolume / 1000}k`, ok: (pmVol ?? 0) >= GATE.minPreMarketVolume,
        detail: pmVol ? Math.round(pmVol).toLocaleString() : 'unknown' },
      { name: 'News catalyst', ok: catalyst.found, detail: catalyst.found ? `${catalyst.kind}` : 'none found' },
      { name: `Price $${GATE.priceMin}–$${GATE.priceMax}`, ok: price >= GATE.priceMin && price <= GATE.priceMax, detail: `$${price.toFixed(2)}` },
      { name: `Float <${GATE.floatIdeal / 1e6}M`, ok: !!float && float.floatShares < GATE.floatIdeal,
        detail: float ? `${(float.floatShares / 1e6).toFixed(1)}M` : 'unknown' },
    ];
    const passed = checks.filter((c) => c.ok).length;

    rows.push({
      symbol: q.symbol,
      name: base?.name ?? q.symbol,
      legalName: profile?.name ?? base?.name ?? null,
      business: profile?.business ?? base?.industry ?? null,
      sector: base?.sector ?? null,
      preMarketPrice: price,
      preMarketChangePct: chg,
      prevClose: pc,
      closeReconciled: reconciled,
      lastTradeAt: q.lastTradeAt,
      preMarketVolume: pmVol,
      preMarketDollarVolume: pmVol ? pmVol * price : null,
      relVolume: relVol,
      avgVolume50: a50,
      sharesOutstanding: sharesOut,
      marketCap,
      floatPctOfShares: float && sharesOut ? (float.floatShares / sharesOut) * 100 : null,
      bestPriorSpikePct: spike.get(q.symbol) ?? null,
      float: float ? { shares: float.floatShares, basis: float.basis, asOf: float.asOf } : null,
      floatRotation: rotation,
      daysUp, priorRunPct: priorRun, extended,
      catalyst,
      leads: leads.map((l) => l.source),
      checks, passed,
      quality: passed === 5 && (pmVol ?? 0) >= GATE.goodPreMarketVolume ? 'high' : passed >= 4 ? 'medium' : 'low',
    });
  }

  rows.sort((a, b) => b.passed - a.passed || b.preMarketChangePct - a.preMarketChangePct);

  const payload = {
    generatedAt: startedAt,
    marketStatus: statusText,
    prevSession,
    universeChecked: universe.length,
    smallCapsInBand,
    investigated: candidates.length,
    liveQuotes: liveQuotes.length,
    feedIsLive,
    discovery: {
      since: new Date(since).toISOString(),
      edgarOk: edgar.ok,
      edgarFilings: edgar.filings,
      leads: {
        '8-K': count('8-K'),
        'PR Newswire': count('PR Newswire'),
        GlobeNewswire: count('GlobeNewswire'),
        'prior-session gainer': count('prior-session gainer'),
      },
      feeds: wires.feeds,
    },
    fetch: { ...fetchStats, answerRatePct: answerRate, reliable: !fetchStats.requested || answerRate >= 50 },
    gate: GATE,
    shortlist: rows.filter((r) => r.passed === 5).slice(0, SHORTLIST_MAX),
    watchlist: rows.filter((r) => r.passed === 4).slice(0, SHORTLIST_MAX),
    alsoRan: rows.filter((r) => r.passed <= 3).slice(0, 10),
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/premarket.json', JSON.stringify(payload, null, 2));

  // Today's alerts go into history only while they are genuinely pre-market.
  if (inPreMarket && feedIsLive) {
    const added = recordScan(history, today, payload, 'live', startedAt);
    console.log(`  history: ${added} new name(s) recorded for ${today}`);
  }
  const filled = await fillPerformance(history, getBars);
  await saveHistory(history);
  if (filled) console.log(`  history: scored ${filled} name(s) from closed sessions`);

  console.log(`\n  SHORTLIST (all five criteria): ${payload.shortlist.length}`);
  for (const r of payload.shortlist) {
    console.log(`   ★ ${r.symbol.padEnd(6)} $${r.preMarketPrice.toFixed(2).padStart(6)} ${(r.preMarketChangePct.toFixed(0) + '%').padStart(6)} ` +
      `vol ${Math.round(r.preMarketVolume ?? 0).toLocaleString().padStart(11)} float ${(r.float ? (r.float.shares / 1e6).toFixed(1) + 'M' : '—').padStart(7)}  ` +
      `${r.catalyst.subject ?? r.catalyst.headline ?? ''}`.slice(0, 160));
  }
  console.log(`  Watchlist (four of five): ${payload.watchlist.map((r: any) => `${r.symbol} +${r.preMarketChangePct.toFixed(0)}%`).join(', ') || 'none'}`);
  console.log(`  Also ran: ${payload.alsoRan.map((r: any) => `${r.symbol} +${r.preMarketChangePct.toFixed(0)}% (${r.passed}/5)`).join(', ') || 'none'}`);
  console.log('\nWrote data/premarket.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
