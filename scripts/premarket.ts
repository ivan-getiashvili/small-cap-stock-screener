/**
 * The pre-market shortlist -> data/premarket.json
 *
 * Run:  npm run premarket        (intended: ~08:45 ET, 45 min before the open)
 *
 * This is the whole product: a handful of tickers to look at before the bell.
 * No backtest, no simulation. It applies the two men's stated pre-market
 * criteria to live quotes and stops there — the trading decision is yours.
 *
 * Cameron's gapper checklist (warriortrading.com/gap-go):
 *   scan gaps > 4% -> hunt the catalyst -> mark pre-market highs -> trade 9:30
 *   quality tiers: float < 20M and pre-market volume > 150k is high quality;
 *   price > $20 or pre-market volume < 50k is low quality.
 *
 * Sykes' pre-market routine (his "Pre-Market Checklist" video):
 *   biggest % gainers FIRST, not the news -> then catalyst and float ->
 *   float rotation is the tell -> a shortlist of one to five names, never 20.
 *
 * Staged so it is cheap: the bulk universe is one request, and only plausible
 * names get a per-symbol pre-market lookup.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getUniverse } from '../lib/sources/nasdaq.ts';
import { getPreMarketQuotes, getMarketStatus } from '../lib/sources/premarket.ts';
import { getTickerToCik, getFloat, makePriceLookup, floatFromSharesOutstanding } from '../lib/sources/sec.ts';
import { findCatalyst } from '../lib/sources/news.ts';

/**
 * Which names are even worth a pre-market lookup. Deliberately generous.
 *
 * NOTE ON REQUEST VOLUME — this is why the scan is shaped the way it is.
 * The first version asked Nasdaq for a quote on every one of ~2,945 small caps.
 * That is ~35,000 requests a day across a normal schedule, and Nasdaq started
 * returning 403 after two runs. Getting blocked is not a rate-limit nuisance,
 * it silently empties the shortlist and looks exactly like a quiet morning.
 *
 * So the scan is now: ONE bulk request for the whole market, then per-symbol
 * lookups for only the handful of names that survive. Roughly 30 requests a
 * scan instead of 2,945.
 */
const UNIVERSE = { priceMin: 1, priceMax: 25, maxMarketCap: 2e9 };
/** How many movers get the expensive per-symbol treatment. */
const INVESTIGATE = 30;
/** The gate for appearing on the shortlist at all. */
const GATE = {
  minPreMarketChangePct: 10,   // Cameron: "up at least 10%"; Sykes: "10%+ pre-market"
  minPreMarketVolume: 50_000,  // Cameron: under 50k pre-market is low quality
  goodPreMarketVolume: 150_000,// …over 150k is high quality
  priceMin: 2, priceMax: 20,   // Cameron's stated sweet spot
  floatIdeal: 10_000_000,      // his "under 10 million shares"
  floatStretch: 20_000_000,
};
const SHORTLIST_MAX = 8;

const pct = (a: number, b: number) => ((a - b) / b) * 100;

/**
 * The closing price of the previous session, written by the post-close snapshot.
 * This is what lets us measure a pre-market move ourselves rather than trusting
 * a vendor's percent-change field to have rolled over.
 */
async function prevCloses(): Promise<Map<string, number>> {
  try {
    const j: Record<string, number> = JSON.parse(await readFile('data/prevclose.json', 'utf8'));
    return new Map(Object.entries(j));
  } catch { return new Map(); }
}

async function avgVolumes(): Promise<Map<string, number>> {
  // 50-day average volume. Prefer the small committed digest, because CI has
  // that but not the multi-hundred-megabyte bar cache. Fall back to the full
  // cache when running locally with it present.
  try {
    const digest: Record<string, number> = JSON.parse(await readFile('data/avgvol.json', 'utf8'));
    return new Map(Object.entries(digest));
  } catch { /* fall through */ }

  const map = new Map<string, number>();
  try {
    const { readdir } = await import('node:fs/promises');
    const dir = 'data/db/daily';
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const bars: any[] = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
        const w = bars.slice(-50);
        if (w.length < 10) continue;
        map.set(f.replace('.json', ''), w.reduce((a, b) => a + b.volume, 0) / w.length);
      } catch { /* skip */ }
    }
  } catch { /* no cache — relative volume simply goes unreported */ }
  return map;
}

async function main() {
  const startedAt = new Date().toISOString();
  const status = await getMarketStatus();
  console.log(`Nasdaq says: ${status?.status ?? 'unknown'}`);

  // --- Stage 1: ONE request for the entire market ---------------------------
  const { quotes: universe, asOf } = await getUniverse();
  const avg = await avgVolumes();
  const prev = await prevCloses();
  console.log(`Universe ${universe.length}; ${avg.size} volume histories; ${prev.size} stored prior closes`);

  const watch = universe.filter(
    (q) => q.price >= UNIVERSE.priceMin && q.price <= UNIVERSE.priceMax &&
           (q.marketCap === null || q.marketCap <= UNIVERSE.maxMarketCap),
  );

  // Is the bulk feed showing live pre-market prices, or still yesterday's close?
  // We can tell by comparing its price against the close we stored last session.
  // Guessing would be the worst outcome: a stale feed silently reports every
  // stock as unchanged and the shortlist is empty for the wrong reason.
  let moved = 0, comparable = 0;
  for (const q of watch) {
    const pc = prev.get(q.symbol);
    if (!pc) continue;
    comparable++;
    if (Math.abs(q.price - pc) / pc > 0.001) moved++;
  }
  const feedIsLive = comparable > 100 && moved / comparable > 0.05;
  console.log(`Bulk feed: ${moved}/${comparable} prices differ from the stored close ` +
              `-> ${feedIsLive ? 'LIVE pre-market pricing' : 'still showing the previous close'}`);

  // Pre-market change: prefer measuring it ourselves against the stored close.
  const candidates = watch
    .map((q) => {
      const pc = prev.get(q.symbol) ?? null;
      const chg = pc && pc > 0 ? ((q.price - pc) / pc) * 100 : q.changePct;
      return { q, prevClose: pc, chg };
    })
    .filter((c) => c.chg >= GATE.minPreMarketChangePct - 5)
    .sort((a, b) => b.chg - a.chg)
    .slice(0, INVESTIGATE);
  console.log(`  ${candidates.length} movers to investigate individually`);

  // --- Stage 2: per-symbol detail, for the shortlist only -------------------
  const { quotes: pm, stats } = await getPreMarketQuotes(
    candidates.map((c) => c.q.symbol), 4,
  );
  const answerRate = stats.requested ? (stats.answered / stats.requested) * 100 : 0;
  console.log(`  ${stats.answered}/${stats.requested} quote lookups answered (${answerRate.toFixed(0)}%)`);
  if (stats.requested && answerRate < 50) {
    console.warn(`  ! only ${answerRate.toFixed(0)}% answered — treat this scan as unreliable`);
  }

  const live = [...pm.values()].filter((q) => !q.stale && q.preMarketChangePct !== null);
  console.log(`  ${live.length} confirmed live pre-market prints`);

  // Use the confirmed per-symbol print where we have one, else the bulk figure.
  const movers = candidates.map((c) => {
    const detail = pm.get(c.q.symbol);
    return {
      symbol: c.q.symbol,
      preMarketPrice: detail?.preMarketPrice ?? c.q.price,
      preMarketChangePct: detail?.preMarketChangePct ?? c.chg,
      prevClose: detail?.prevClose ?? c.prevClose,
      volume: detail?.volume ?? c.q.volume,
      confirmed: !!detail && !detail.stale,
    };
  });

  const cikMap = await getTickerToCik().catch(() => new Map<string, string>());
  const today = new Date().toISOString().slice(0, 10);
  const rows: any[] = [];

  for (const q of movers) {
    const base = universe.find((u) => u.symbol === q.symbol);
    const price = q.preMarketPrice ?? base?.price ?? null;
    if (price === null) continue;

    const cik = cikMap.get(q.symbol) ?? null;
    let float = null;
    try {
      const bars: any[] = JSON.parse(await readFile(`data/db/daily/${q.symbol}.json`, 'utf8')).slice(-400);
      const sec = cik ? await getFloat(q.symbol, makePriceLookup(bars)).catch(() => null) : null;
      const so = base?.sharesOutstanding ?? null;
      // Same plausibility gate as the main screener: an implausible float is
      // worse than an absent one, because float decides everything here.
      if (sec && so && sec.floatShares / so >= 0.05 && sec.floatShares <= so) float = sec;
      else float = floatFromSharesOutstanding(so, today);
    } catch {
      float = floatFromSharesOutstanding(base?.sharesOutstanding ?? null, today);
    }

    const catalyst = await findCatalyst(q.symbol, cik, today);
    const pmVol = q.volume ?? null;
    const a50 = avg.get(q.symbol) ?? null;
    const relVol = pmVol && a50 ? pmVol / a50 : null;
    const rotation = pmVol && float ? pmVol / float.floatShares : null;

    const checks = [
      { name: `Up ≥${GATE.minPreMarketChangePct}% pre-market`, ok: (q.preMarketChangePct ?? 0) >= GATE.minPreMarketChangePct,
        detail: `${(q.preMarketChangePct ?? 0).toFixed(1)}%` },
      { name: `Pre-market volume ≥${(GATE.minPreMarketVolume/1000)}k`, ok: (pmVol ?? 0) >= GATE.minPreMarketVolume,
        detail: pmVol ? pmVol.toLocaleString() : 'unknown' },
      { name: 'News catalyst', ok: catalyst.found,
        detail: catalyst.found ? `${catalyst.kind}` : 'none found' },
      { name: `Price $${GATE.priceMin}–$${GATE.priceMax}`, ok: price >= GATE.priceMin && price <= GATE.priceMax,
        detail: `$${price.toFixed(2)}` },
      { name: `Float <${GATE.floatIdeal/1e6}M`, ok: !!float && float.floatShares < GATE.floatIdeal,
        detail: float ? `${(float.floatShares/1e6).toFixed(1)}M` : 'unknown' },
    ];
    const passed = checks.filter((c) => c.ok).length;

    rows.push({
      symbol: q.symbol,
      name: base?.name ?? q.symbol,
      preMarketPrice: price,
      preMarketChangePct: q.preMarketChangePct,
      prevClose: q.prevClose,
      preMarketVolume: pmVol,
      relVolume: relVol,
      float: float ? { shares: float.floatShares, basis: float.basis, asOf: float.asOf } : null,
      floatRotation: rotation,
      catalyst,
      checks, passed,
      quality: passed === 5 && (pmVol ?? 0) >= GATE.goodPreMarketVolume ? 'high'
             : passed >= 4 ? 'medium' : 'low',
      sector: base?.sector ?? null,
    });
  }

  rows.sort((a, b) => b.passed - a.passed || (b.preMarketChangePct ?? 0) - (a.preMarketChangePct ?? 0));

  const payload = {
    generatedAt: startedAt,
    marketStatus: status?.status ?? null,
    prevSession: asOf,
    universeChecked: watch.length,
    liveQuotes: live.length,
    feedIsLive,
    fetch: { ...stats, answerRatePct: answerRate, reliable: !stats.requested || answerRate >= 50 },
    gate: GATE,
    shortlist: rows.filter((r) => r.passed === 5).slice(0, SHORTLIST_MAX),
    watchlist: rows.filter((r) => r.passed === 4).slice(0, SHORTLIST_MAX),
    alsoRan: rows.filter((r) => r.passed <= 3).slice(0, 10),
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/premarket.json', JSON.stringify(payload, null, 2));

  console.log(`\n  SHORTLIST (all five criteria): ${payload.shortlist.length}`);
  for (const r of payload.shortlist) {
    console.log(`   ★ ${r.symbol.padEnd(6)} $${r.preMarketPrice.toFixed(2).padStart(6)} ` +
      `${(r.preMarketChangePct.toFixed(0)+'%').padStart(6)} vol ${(r.preMarketVolume??0).toLocaleString().padStart(11)} ` +
      `float ${(r.float ? (r.float.shares/1e6).toFixed(1)+'M' : '—').padStart(7)}  ${r.catalyst.headline ?? ''}`.slice(0, 150));
  }
  console.log(`  Watchlist (four of five): ${payload.watchlist.map((r: any) => r.symbol).join(', ') || 'none'}`);
  console.log('\nWrote data/premarket.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
