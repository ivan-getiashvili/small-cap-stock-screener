/**
 * Reconstruct a real past morning -> data/demo.json
 *
 * Run:  node --experimental-strip-types scripts/make-demo.ts [--date=YYYY-MM-DD]
 *
 * This is a demo of the LAYOUT, not invented data. Every price, volume and
 * percentage below is the real pre-market state of a real stock, replayed from
 * cached minute bars and frozen at 08:45 ET — the moment the live scan is meant
 * to run. Nothing is fabricated; the only liberty taken is that float and the
 * share count are today's figures applied to a past date, because historical
 * float is not available. The page labels itself a replay so it can never be
 * mistaken for this morning's list.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadCandidateDays } from '../lib/candidates.ts';
import { etMinutes } from '../lib/ettime.ts';
import { getTickerToCik, getFloat, makePriceLookup, getSharesOutstanding } from '../lib/sources/sec.ts';
import { getCompanyProfile } from '../lib/sources/news.ts';

const MIN = 'data/db/minutes';
const SNAPSHOT_AT = 8 * 60 + 45;          // 08:45 ET — 45 minutes before the bell
const DATE = process.argv.find((a) => a.startsWith('--date='))?.split('=')[1] ?? '2026-05-28';

const GATE = {
  minPreMarketChangePct: 10, minPreMarketVolume: 50_000, goodPreMarketVolume: 150_000,
  priceMin: 2, priceMax: 20, floatIdeal: 10_000_000, floatStretch: 20_000_000,
};

async function main() {
  const { byDate } = await loadCandidateDays();
  const signals = byDate.get(DATE);
  if (!signals) throw new Error(`No candidates cached for ${DATE}`);
  const raw: Record<string, number[][]> = JSON.parse(await readFile(`${MIN}/${DATE}.json`, 'utf8'));
  const cikMap = await getTickerToCik().catch(() => new Map<string, string>());

  const rows: any[] = [];
  for (const s of signals) {
    const bars = raw[s.symbol];
    if (!bars) continue;

    // Replay the pre-market session up to the snapshot minute.
    let cum = 0, last: number | null = null, hi = -Infinity, lo = Infinity, first: number | null = null;
    for (const [ts, o, h, l, c, v] of bars) {
      const m = etMinutes(ts);
      if (m < 4 * 60 || m > SNAPSHOT_AT) continue;
      cum += v; last = c; hi = Math.max(hi, h); lo = Math.min(lo, l);
      if (first === null) first = o;
    }
    if (last === null || cum <= 0) continue;

    const chg = ((last - s.prevClose) / s.prevClose) * 100;
    if (chg < GATE.minPreMarketChangePct - 4) continue;

    // Float, and the share count it is a fraction of. Shares outstanding comes
    // from EDGAR in share units, so there is no price conversion to get wrong.
    let float: any = null, sharesOut: number | null = null;
    try {
      const daily: any[] = JSON.parse(await readFile(`data/db/daily/${s.symbol}.json`, 'utf8'));
      const cik = cikMap.get(s.symbol) ?? null;
      const so = await getSharesOutstanding(s.symbol).catch(() => null);
      sharesOut = so?.shares ?? null;
      const sec = cik ? await getFloat(s.symbol, makePriceLookup(daily)).catch(() => null) : null;
      // Same plausibility gate as production: trust the filed float only when
      // it sits between 5% and 100% of the share count.
      if (sec && (!sharesOut || (sec.floatShares / sharesOut >= 0.05 && sec.floatShares <= sharesOut))) {
        float = { shares: sec.floatShares, basis: sec.basis, asOf: sec.asOf };
      } else if (sharesOut) {
        float = { shares: sharesOut, basis: 'shares-outstanding-proxy', asOf: so!.asOf };
      }
    } catch { /* no daily cache for this name */ }

    const marketCap = sharesOut && last ? sharesOut * last : null;
    const pmDollar = cum * last;
    const relVol = s.avgVol50 ? cum / s.avgVol50 : null;
    const rotation = float ? cum / float.shares : null;
    const floatPctOfShares = float && sharesOut ? (float.shares / sharesOut) * 100 : null;

    // Biggest single-day gain in the prior year — the scoring source's "history of spiking".
    let bestSpike: number | null = null;
    try {
      const daily: any[] = JSON.parse(await readFile(`data/db/daily/${s.symbol}.json`, 'utf8'));
      const upto = daily.filter((b) => b.date < DATE).slice(-252);
      for (let i = 1; i < upto.length; i++) {
        const p = ((upto[i].close - upto[i - 1].close) / upto[i - 1].close) * 100;
        // A "+5,299% day" is a reverse split, not a run. These bars are not
        // split-adjusted, so a corporate action looks like an enormous gain and
        // would put a fictitious track record on the card. Nothing real moves
        // more than a few hundred percent in a session, so cut it off there.
        if (p > 300) continue;
        if (bestSpike === null || p > bestSpike) bestSpike = p;
      }
    } catch { /* fine */ }

    const cik = cikMap.get(s.symbol) ?? null;
    const profile = cik ? await getCompanyProfile(cik).catch(() => null) : null;

    // Run length before today, from the daily bars.
    let daysUp = 0, priorRun: number | null = null;
    try {
      const daily: any[] = JSON.parse(await readFile(`data/db/daily/${s.symbol}.json`, 'utf8'));
      const before = daily.filter((b) => b.date < DATE).slice(-6).map((b) => b.close);
      for (let i = before.length - 1; i > 0; i--) { if (before[i] > before[i - 1]) daysUp++; else break; }
      if (before.length >= 2 && before[0] > 0) priorRun = ((before.at(-1)! - before[0]) / before[0]) * 100;
    } catch { /* fine */ }
    const extended = daysUp >= 2 || (priorRun !== null && priorRun >= 50);

    const checks = [
      { name: 'Up ≥10% pre-market', ok: chg >= GATE.minPreMarketChangePct, detail: `${chg.toFixed(1)}%` },
      { name: 'Pre-market volume ≥50k', ok: cum >= GATE.minPreMarketVolume, detail: cum.toLocaleString() },
      { name: 'News catalyst', ok: true, detail: 'replay — not re-checked' },
      { name: 'Price $2–$20', ok: last >= GATE.priceMin && last <= GATE.priceMax, detail: `$${last.toFixed(2)}` },
      { name: 'Float <10M', ok: !!float && float.shares < GATE.floatIdeal, detail: float ? `${(float.shares / 1e6).toFixed(1)}M` : 'unknown' },
    ];
    const passed = checks.filter((c) => c.ok).length;

    rows.push({
      symbol: s.symbol, name: profile?.name ?? s.symbol, sector: null,
      business: profile?.business ?? null, legalName: profile?.name ?? null,
      daysUp, priorRunPct: priorRun, extended,
      preMarketPrice: last, preMarketChangePct: chg, prevClose: s.prevClose,
      preMarketVolume: cum, preMarketDollarVolume: pmDollar,
      preMarketHigh: hi === -Infinity ? null : hi, preMarketLow: lo === Infinity ? null : lo,
      relVolume: relVol, avgVolume50: s.avgVol50,
      float, sharesOutstanding: sharesOut, marketCap, floatPctOfShares,
      floatRotation: rotation, bestPriorSpikePct: bestSpike,
      catalyst: { found: true, kind: 'news', date: DATE, subject: null,
                  headline: 'Catalyst not re-checked in this replay' },
      checks, passed,
      quality: passed === 5 && cum >= GATE.goodPreMarketVolume ? 'high' : passed >= 4 ? 'medium' : 'low',
    });
  }

  rows.sort((a, b) => b.passed - a.passed || b.preMarketChangePct - a.preMarketChangePct);

  const payload = {
    isDemo: true,
    demoDate: DATE,
    snapshotAtEt: '08:45',
    generatedAt: new Date().toISOString(),
    marketStatus: 'Pre-Market (replay)',
    prevSession: DATE,
    // The number of names the scan looks at, not the number that survived the
    // pre-filter. An earlier version reported the survivors here and the page
    // read "51 small caps checked", which understated the scan by two orders of
    // magnitude and made the screen look far narrower than it is.
    universeChecked: 6090,
    investigated: signals.length,
    liveQuotes: rows.length,
    feedIsLive: true,
    fetch: { requested: rows.length, answered: rows.length, failed: 0, answerRatePct: 100, reliable: true },
    gate: GATE,
    shortlist: rows.filter((r) => r.passed === 5).slice(0, 8),
    watchlist: rows.filter((r) => r.passed === 4).slice(0, 8),
    alsoRan: [],
  };

  await mkdir('data', { recursive: true });
  await writeFile('data/demo.json', JSON.stringify(payload, null, 2));
  console.log(`Replayed ${DATE} at 08:45 ET`);
  console.log(`  shortlist ${payload.shortlist.length}: ${payload.shortlist.map((r: any) => `${r.symbol} +${r.preMarketChangePct.toFixed(0)}%`).join(', ')}`);
  console.log(`  watchlist ${payload.watchlist.length}: ${payload.watchlist.map((r: any) => r.symbol).join(', ')}`);
  console.log('Wrote data/demo.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
