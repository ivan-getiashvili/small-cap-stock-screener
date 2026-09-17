# Small Cap Stock Screener

An intraday small-cap momentum screener built on the published criteria of two
day traders: **the momentum source** (the operator) and **the scoring source**.
Owner: Ivan. Beginner at web dev — explain concepts when introducing them.

Completely separate from the BTC dashboard project. Nothing is shared.

## What it does

**The product is one page: a pre-market shortlist of small caps, published
before the open.** Everything else is supporting research.

- `_site/index.html` — the shortlist. Built by `npm run site`, refreshed by CI
  every 20 minutes through the pre-market window.
- `_site/research.html` — the end-of-day screener and the backtests.

## The pre-market scan, and why it is shaped this way

**Verified live on 2026-09-14 — read before touching discovery.**

- **Nasdaq has no free live pre-market list.** During pre-market its bulk
  screener still shows the previous close for all 6,090 stocks, and every movers
  list (`api/marketmovers`) is stamped with the previous session. The
  `exchangestatus=premarket` parameter is ignored everywhere.
- **Live pre-market data exists only per symbol**, in `primaryData` of
  `api/quote/{sym}/info`: real-time, stamped today ("Sep 14, 2026 5:56 AM ET"),
  with the session's volume. It matched the 1-minute chart exactly.
  `secondaryData` is NOT trustworthy — usually the previous close, but for SXTC it
  repeated the live price. The first adapter read the two blocks backwards.
- **A quote counts as live only if `isRealTime` and stamped with today's New York
  date.** The move is measured against our own stored close; if Nasdaq's own
  change disagrees by more than 2 points, Nasdaq's figure wins (stale close).
- **Nasdaq's "as of" date label is unreliable** — one screener variant said
  "Aug 19" while another said "Sep 11". The previous session comes from the last
  completed AAPL daily bar.
- **Nasdaq's status text is "Pre Market"** (space). Test with
  `/pre[\s-]?market/i`, never `/pre-market/i`.

**So discovery is catalyst-first** (`lib/sources/discovery.ts`). Asking about all
~3,400 small caps got us 403'd after two runs; instead the scan quotes only
symbols with a reason to move — ~80 lookups, all answered:

| source | what it gives | caveat |
|---|---|---|
| SEC 8-K Atom feed | filings since 15:30 ET of the previous session → tickers | lags press releases |
| PR Newswire RSS (2 feeds) | same-morning releases with `(NASDAQ: XXX)` tickers | 20 items per feed; main feed is flaky (404/200/404), so fetches retry |
| GlobeNewswire RSS | same | 20 items; unreachable from the Mac once, fine from CI |
| previous session's top gainers | yesterday's runners | flagged extended if already running |

Not usable: Business Wire (no tickers in the feed, release pages 403) and
Accesswire (bot challenge — do not try to get past it).

**Known blind spot:** a microcap whose news breaks only on a wire we cannot read,
before it files an 8-K. And busy mornings overflow the 20-item wire feeds.

**After the bell** the morning's final pre-market list is kept, not re-scanned.
Each scan commits `data/premarket.json` and `data/history.json`, because every
CI run starts from a clean checkout.

## Launch (2026-09-15): hosting and the clock

Ivan launched it as a screener only ("let it just be the screener"). What runs
where:

- **Scans** stay in GitHub Actions (`premarket.yml`), which has the SEC contact
  string and commits the data. `workflow_dispatch` takes `mode`: `scan`,
  `snapshot` (closes + scoring) or `publish` (rebuild and publish the page from
  the committed JSON, no scan — use it after a page change).
- **GitHub's schedule is not a clock.** It started 2 of 14 runs on 2026-09-14
  and fired twice at random times. Until the Worker below is live, the scans on
  a live day come from a `gh workflow run` loop on the Mac (see the session
  history); do not assume a scan happened because the cron line exists.
- **The Worker** (`worker/index.ts`, `wrangler.jsonc`) serves `_site/` and, on
  the same cron lines as the workflow, starts the workflow through GitHub's API.
  Needs the Worker secret `GITHUB_DISPATCH_TOKEN` (fine-grained, Actions
  read/write on this repo), which Ivan adds. Tested locally with
  `npm run worker:dev` and `.dev.vars` containing `DRY_RUN=1`, then
  `curl "localhost:8787/__scheduled?cron=10+21+*+*+1-5"`.
- **Deploy path:** Workers Builds from `main` (build `npm run build:pages` —
  NOT `npm ci`, the project has no dependencies and no lockfile, so `npm ci`
  exits with EUSAGE; deploy `npx wrangler deploy`; NODE_VERSION=24; build token
  "cyclebasis build token"). Connected in the Cloudflare dashboard on
  2026-09-15 as Worker `smallcap-premarket`. Every scan commit then republishes.
  GitHub Pages keeps serving until the domain is on; once Cloudflare serves, the
  repo can go private and the Pages job comes out of the workflow.
- `npm run build:pages` is the one build script for CI and Cloudflare.
- **Domain: https://smallcapscreener.net** (+ www), bought 2026-09-15 through
  Cloudflare Registrar with Ivan's go-ahead ($11.86/year, auto-renew on, WHOIS
  privacy on; `.us` was rejected because it demands a US-nexus declaration and
  public WHOIS). Attached as custom domains in `wrangler.jsonc`; verified with a
  valid certificate the same day. Fallback: the workers.dev address. The
  notifications (`SITE_URL`) and the Claude scheduled task point at the domain.
- **Registrar search gotcha:** the keyword results page's text comes through
  with prices shifted by one row; only the exact-name search ("Buy now:
  smallcapscreener.net for $11.86") is trustworthy. A wrong $5.30 was quoted
  once because of this.

## Readable by machines (2026-09-17) — do not regress

Ivan will list the site on a platform where AIs match and read it, so an AI
given the link must get everything a person sees. Tested on 2026-09-17 before
the fix: a fetch returned **142 characters** (title + subtitle) and an AI
reader reported every list "not present", because the lists were drawn only by
JavaScript; the head said `noindex`; `/robots.txt`, `/sitemap.xml`, `/llms.txt`
and any wrong path returned the homepage with HTTP 200.

What keeps it readable now (`lib/prerender.ts`, `scripts/build-premarket.ts`):
- The build writes the whole content into the HTML — status line, every stock
  with all its numbers, the five criteria, and the full history table — inside
  the same containers the page's script then redraws. `#history` is NOT
  `hidden` in the markup (Readability-style readers drop hidden nodes); the
  script collapses it at load. The build fails if a container is missing.
- `/llms.txt` (the page as Markdown), `/history.json`, `/premarket.json`,
  `/robots.txt` (allow all, AI agents named), `/sitemap.xml`, `/404.html` with
  `not_found_handling: "404-page"` so wrong URLs answer 404.
- Head: `index, follow`, canonical to the domain, Open Graph, JSON-LD
  (`WebSite` + `Dataset` with the three downloads), `rel=alternate` links.
- Cloudflare does not block AI user-agents on this zone (all 200 on 2026-09-17:
  GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot,
  Googlebot, bingbot, CCBot, Bytespider, meta-externalagent). If "Block AI
  bots" / AI Crawl Control is ever switched on in the dashboard, this breaks.
- **How to re-test:** strip `<script>`/`<style>` from the fetched HTML and
  check the tickers, criteria and history stats are in the remaining text; then
  fetch the URL with an AI reader and ask it to list the stocks.
- Any new block on the page needs its twin in `lib/prerender.ts`.

## Track record (`data/history.json`, `lib/history.ts`) — on the page: "Historical performance"

Page order since 2026-09-15 (Ivan's call): shortlist and watchlist first, then
"How it screens" open underneath, then "Historical performance" at the bottom
behind a button. One number per name: the run from the flag price to the high
of the day. The "flagged at +x% @ $p" column was removed because a pre-market
change next to an after-flag run read as two contradictory numbers.

Every name that reaches the shortlist or watchlist is recorded as it looked when
first flagged, then scored after the close on that session: open, noon (last
price at or before 12:00 ET), high, low, close. **The page measures all of them
from the flag price** — the pre-market price the list showed — because that is
what a reader could have acted on, and a name that runs between 08:45 and the
open would otherwise hide its move (Ivan asked for exactly this on 2026-09-14).
Losers are recorded exactly like winners.

- A watchlist name that later clears all five is upgraded and re-snapshotted at
  that moment.
- Scoring runs in the nightly job (`npm run history:fill`) and at each scan.
- **The noon price needs intraday data.** Nasdaq's chart endpoint
  (`getIntraday`) shows the current day only, so only the nightly job can fill it,
  the same evening; if that run fails, the day's noon stays blank for good. Its
  timestamps are New York wall-clock written as UTC — the adapter shifts them.
  Replayed days get noon from the local Databento minute caches when
  `DATABENTO_KEY` is set (`scripts/fill-history.ts`).
- Up/down marks use blue `#3987e5` / red `#e66767`. The page's own green/red
  failed the colour-blind check (deuteranopia ΔE 4.4); blue/red passes (ΔE 19.2).

**Replay backfill** (`scripts/backfill-history.ts`, source `replay`) — the rules
that stop it showing big moves by construction:

1. Replays **every** symbol priced $1–$25 at the previous close — never days
   pre-selected because they later moved.
2. Pre-market from Databento `XNAS.BASIC` 1-minute bars up to 08:45 ET only.
3. A catalyst counts only if its 8-K was **accepted** (EDGAR `acceptanceDateTime`)
   between 15:30 ET the previous session and 08:45 ET that morning. Press releases
   can't be replayed, so replayed lists are a subset of what live would find.
4. `XNAS.BASIC` carries ~48–83% of volume, so the 50k gate runs on an undercount.
5. Known leak: float uses today's filed share count.

Cost: ~$0.035 per session (~$0.71 for 20). Run `--dry` first.

## Session strategies compared (2026-09-14, `npm run strategies`, `npm run early`)

Ivan asked whether the method is "buy pre-market, sell after the open", how
simple holds compare, and then why not flag earlier (04:00–07:00), buy
pre-market and sell 15 minutes after the bell. Two scripts answer, both on 530
sessions Aug 2024 – Sep 2026 with the live gate (up 10%+ on the previous close,
50k+ shares so far, $2–$20), buys at the real ask and timed sells at the real
bid (`cbbo-1m`), funds and non-common tickers excluded, no position size. 20
trades of each were recomputed by a separate script from the raw caches and match.

**Holds from the 08:45 flag** (`scripts/session-strategies.ts` →
`data/strategies.json`, 4,238 stock-days, ~$3 of Databento credit):

| strategy | won | median | mean |
|---|---|---|---|
| pre-market (08:45) → open | 34% | −1.4% | −1.3% |
| pre-market → close | 35% | −5.0% | −2.1% |
| open → noon | 37% | −3.3% | −1.8% |
| open → close | 39% | −3.2% | −0.9% |
| open, 5 / 10 / 20% trailing stop | 32–38% | −2.4 to −3.6% | −1.0 to −1.1% |

**Earlier flags** (`scripts/early-flags.ts` → `data/early-flags.json`; every
small cap $1–$25 at the previous close replayed from its own pre-market bars, no
preselection, $5.35). Mean return per trade; "→ 08:45" is the median move from
the flag to 08:45:

| flagged at | names/day | shares so far | ½ spread | → 08:45 | → open | → 09:45 | → close |
|---|---|---|---|---|---|---|---|
| first minute it qualifies (median 07:10) | 14.3 | 65k | 0.99% | −3.6% | −5.6% | −6.8% | −6.7% |
| 06:00 | 3.8 | 473k | 0.45% | −4.0% | −4.2% | −5.1% | −4.5% |
| 07:00 | 4.3 | 625k | 0.43% | −2.8% | −3.8% | −4.9% | −4.5% |
| 08:00 | 6.6 | 988k | 0.51% | −1.3% | −2.4% | −3.3% | −3.5% |
| 08:45 | 8.0 | 1.25M | 0.48% | — | −1.4% | −2.1% | −2.2% |

Every hold loses on average, in each of the three years, won 25–35% of the
time, and every 95% range sits below zero. **The earlier the flag, the worse:**
a stock that is up 10% at 05:00 is usually already fading by 08:45. The move
(median +46% previous close → high) is the gap itself, which exists before any
scan can see it. Neither trader holds across the open: the momentum source
trades minutes-long bursts 07:00–11:00 ET, the scoring source buys morning
spikes and panic dips in the session. This is the broad gate, not the strict
shortlist (catalyst + float), which was not replayed.

Sampling lessons, so nobody repeats them:
- The first strategies run forgot the fund list: 596 of 4,834 trades were
  leveraged ETFs (TZA, UVIX, BITI…) and flattered every row by ~0.2–0.4 points.
  `data/db/etfs.json` comes from Nasdaq's `nasdaqtraded.txt` (ETF = Y).
- A daily-bar preselection (open up 2%+, or high 10%+, or 3× 20-day volume)
  keeps every 08:45 flag (71/71) but loses 16 of 273 earlier qualifiers — all
  pre-market spikes that collapsed before the bell, invisible in daily bars. For
  anything before 08:45, replay the whole band (~$0.01 a session).
- The older `data/db/minutes` cache selected on the day's HIGH and missed 25 of
  71 real gappers; never reuse it for pre-market questions.
- Databento returned every bar twice for 2025-06-09 only. Both scripts drop
  repeated timestamps on read; the early-flags numbers above predate that guard,
  so that one session's volume gate was met a little early.

## Where the edge is not (2026-09-14, the "last mile" tests)

Ivan wanted to "crack it": the screener finds the movers, so where is the
money? Five more tests, all on the 08:45-flagged sample (4,257 stock-days,
530 sessions) with real bid/ask fills, all in the repo with their data:

| test | script → result file | what it says |
|---|---|---|
| **When the high happens** | `npm run high-timing` → `data/high-timing.json` | Only **30%** of flagged names ever trade 20% above the flag price (median high after the flag +10%; the +46% "previous close → high" figure includes the gap that happened before the flag). Of those that do, the level is first reached before the open 28%, by 09:45 55%, by 11:00 80%, **by noon 85%**. 60% of all highs fall before 10:00; a third of the runners peak in the afternoon. |
| **Ivan's hold: no stop, +20% target, out at noon/close** | same | 26% hit +20% by noon; the other 74% exit at noon at **−8.3% mean**; net −1.3%/trade (noon), −0.9% (close). +10% target → close wins 56% with a +5% median but the mean is −1.1% (uncapped losers, worst −72%). |
| **The sweep** (target 3–30% × give-up 09:45–close × stop none/5/10/20% × entry flag/open) | `npm run target-sweep` → `data/target-sweep.json` | **576 settings, none positive in-sample, none positive out-of-sample, none with a 95% range above zero.** The whole grid sits at −0.9% to −3.1%; a 3% target wins 73% of trades and still loses 1%. Stops make it worse. The grid sits within ~1% of zero, which is the round-trip spread (median half-spread 0.48%): before costs these holds are a coin flip. |
| **Their playbook, mechanically** (Gap and Go on the first candle's high / the pre-market high, first pullback 07:00–11:00; 20c-capped stops; 2:1 all-out or half-off-and-trail on red candle/MACD; up to 3 re-entries; $500 risk; liquidity-capped) | `npm run playbook` → `data/playbook.json`, 7,554 stock-days | First pullback **−0.94R** net (24% won; −0.17R before spread and commission); Gap and Go **−0.41R** (33% won; **+0.13R gross**). Costs are 0.3–0.6R per trade with 20c stops on $3–6 stocks. Wider stops (4%+ of price) still −0.3R. Negative every year. 9 trades recomputed independently: 8 exact, 1 rounding. |
| **The strict shortlist** (catalyst = 8-K/6-K accepted prev 15:30 → 08:45, float = shares outstanding filed before the morning, rvol = pre-market shares ÷ 50-day avg, day one) | `npm run strict` → `data/strict-shortlist.json`, EDGAR cached under `data/db/edgar` | **Float < 10M raises the runner rate from 30% to 45%** (rvol ≥ 5× to 44%, strict + rvol to 50%) — their selection claim is real — but the misses fade harder, so the best subset (+20% target → close, float < 10M) is **+0.2% with a 95% range of −1.2% … +1.5%**: zero after costs. Catalyst-only: −0.4%. Strict (n = 209): −0.5%. Playbook on the strict subset: −0.6R. |

The pattern across everything: **the selection finds volatility, not direction**.
From any price you can buy at, the expected move is about zero; every rule then
pays the spread (≈1% round trip) or the stop. The one positive number in all of
it is +0.13R gross on the opening breakout — an edge for whoever pays no spread.

Daily-bar side note (`gap ≥ 10% at the open`, all symbols): bigger stocks gap
less often (2.4/session at $20–50, 1.5 at $50–200 vs 14 at $2–20), run less
(6% and 3% reach +20% from the open vs 17%) and fade less (mean open → close
−1.4%, −0.5%, +0.2% for $200+). The runner phenomenon is a micro-cap thing.

### Options (2026-09-14/15): the call is priced for the move

Ivan's idea: buy a call instead of holding the stock, so a fade costs premium
and a run is kept. Real OPRA quotes via Databento (`OPRA.PILLAR`, parent
symbology `XXXX.OPT`; a 422 means no listed options; ~$0.04 per stock-day for a
whole chain, ~$0.001 for a five-minute window). Same-day expiries exist on a
few of these names; nothing trades pre-market.

- **On the flagged small caps** (`npm run options-pilot` → `data/options-pilot.json`):
  39% have options at all. The weekly call at the strike above the open,
  bought at 09:31, costs **9.0% of the stock price** with a **36% bid-ask spread
  on the premium**; monthly 15.5% and 45%. Held to the close or sold the minute
  the stock is +10% / +20%: −23% to −33% of premium; as a share of stock
  exposure −3.8% to −7.8%, against −0.1% to −0.8% for the stock itself.
- **Smallest weekly-optionable stocks** (`npm run optionable-universe`,
  `npm run weekly-cost` → `data/weekly-cost.json`): Cboe's weeklys directory ×
  Nasdaq caps, ETFs out → 550 stocks; bottom decile = 55 names, $40M–$1.2B,
  median price $3.63 (BYND, TLRY, SPCE, HTZ, RILY, INO, CAPR…). They move:
  median |day| 3.1%, a third of days 5%+, 62% of weeks 5%+ (29% up 5%+). But on
  a random day the nearest weekly ATM call (median 4 days) costs **4.6% of the
  stock, with a 42% spread**, and pays back −31% of premium at expiry; the
  monthly (11.9%) −24%. On days the stock opened 5%+ up the weekly costs 6.3%
  and loses 25% of premium, the monthly 14.5% and loses 63%. Same-day expiries
  (n = 16) cost 2.6% and came out flat. Nothing near the 1% Ivan hoped for:
  the premium is the volatility; a stock that moves 5% a week cannot have a 1%
  weekly option.

Where the reference files live: `data/reference/` (Cboe weeklys CSV, Nasdaq
universe with caps, the bottom-decile list), dated.

## The finding that matters

The backtest is negative. Over 3,524 historical signals, **every exit rule
tested lost money**, and a $2,000 account on the momentum source's own stop-and-target was
blown out in five weeks. Survivorship bias makes that test *optimistic* and it
is still negative.

The reason is visible in two numbers: next-day open→close median **−1.67%**,
but open→high median **+6.32%**. The spike is real and then given back. What is
missing from the mechanical filter is exactly what both methodologies emphasise — the
**news catalyst** and **intraday execution measured in minutes**. Do not present
this screener as a profitable system. It is a candidate finder.

## Which file to touch

| To change… | Edit |
|---|---|
| Thresholds — price band, float cap, RVOL, score weights | `lib/screen.ts` (`CRITERIA`) |
| Stop, target, position size, max positions | `lib/strategy.ts` (`RULES`) |
| Exit rules compared in the backtest | `lib/variants.ts` |
| Colours, layout, wording | `page/template.html` |
| Which stocks get investigated | `scripts/ingest.ts` (`PREFILTER`) |
| Swap or add a data vendor | a file in `lib/sources/` — nothing else |

## Commands

```
# the product
npm run site          # pre-market scan + build -> _site/index.html
npm run history:fill  # score recorded names on closed sessions
npm run premarket     # scan only -> data/premarket.json
npm run snapshot      # record closing prices (run after the close)

# research
npm run ingest        # end-of-day screener -> data/screen.json
npm run build         # bake into _site/index.html
npm run build:site    # both
npm run paper         # advance the paper account (run after the close)

# daily-resolution backtest (free data, crude)
node --experimental-strip-types scripts/fetch-history.ts     # ~5 min
npm run backtest

# minute-resolution backtest (Databento, survivorship-free) — the real one
node --experimental-strip-types scripts/fetch-db-universe.ts     # ~$9.75, 20 min
node --experimental-strip-types scripts/backtest-intraday.ts --dry   # price it
node --experimental-strip-types scripts/backtest-intraday.ts         # ~$3.30
```

`.env.local` (gitignored, chmod 600) must define:
- `SEC_USER_AGENT` — EDGAR returns 403 without a contact string
- `DATABENTO_KEY` — minute bars and the survivorship-free universe

Always run a `--dry` first: it prints the exact dollar cost before spending.

## Databento — the dataset trap

**Use `XNAS.BASIC` for minute bars. Nothing else.** Measured against FTFT's
real 52,847,168-share session:

| dataset | volume captured |
|---|---|
| `DBEQ.BASIC` | 0.1% |
| `EQUS.MINI` | 1.2% |
| `XNAS.ITCH` | 3.8% |
| **`XNAS.BASIC`** | **76.6%** |
| `EQUS.SUMMARY` | 100.8% — but daily bars only |

Most small-cap volume prints off-exchange through the FINRA/Nasdaq TRF, and
only `XNAS.BASIC` carries it. Relative volume and float rotation *are* the
strategy, so the wrong dataset does not degrade the screener — it inverts it
while looking perfectly healthy. Capture still varies 48–83% per stock, so
minute volume should be calibrated against the true daily total from
`EQUS.SUMMARY` before being trusted in absolute terms.

Verified: **37 of 40 probed delisted tickers still return minute bars**, which
is what makes the survivorship-free universe possible.

## Hard rules

1. **Never call a third-party API from browser code.** Data flows: scheduled
   ingest → stored JSON → baked into the page. The page makes no requests.
2. **Every data source lives behind an adapter** in `lib/sources/`, exposing a
   fixed shape. The screener must never know which vendor a number came from.
3. **No secrets in the repo.** `.env.local` only.
4. **Stale data must be labelled stale.** `asOf` is derived from the data —
   Nasdaq's stated session, corrected against the newest real bar — never from
   the clock. A Saturday scan must not claim Saturday prices.
5. **A wrong number is worse than a missing one.** This applies hardest to
   float: where the figure fails a plausibility check the UI says "unknown".
6. **Never make the backtest look better than it is.** When a bar covers both
   stop and target, always assume the stop hit first, and report what share of
   results rest on that assumption.
7. **Select backtest days on the HIGH, never the close.** A day qualifies if it
   reached +10% intraday, not if it closed there. Selecting on the close drops
   every stock that spiked at 10am and died by the bell — exactly the losing
   trade the strategy must be measured against.
8. **The universe comes from historical instrument definitions, never from
   today's listings.** Small caps delist constantly; building from what exists
   today deletes most of the losers.
9. **Check `--dry` cost before any Databento pull.**
10. **Be a good citizen of a free API.** Nasdaq has no key and no published
    quota, which makes it easy to abuse and easy to get blocked. Bulk endpoints
    first, per-symbol lookups only for a shortlist, and back off on 403.
11. **An empty result must never be ambiguous.** Distinguish "nothing
    qualified" from "the feed failed", on the page and in CI.

## Data sources (all free, all keyless)

| Source | Used for | Note |
|---|---|---|
| Nasdaq screener API | whole-market price, % change, volume, market cap | `download=true` is what adds the volume column |
| Nasdaq per-symbol history | daily OHLCV — relative volume, gaps, backtest | ~0.5 s per symbol |
| SEC EDGAR `dei:EntityPublicFloat` | float | annual, in dollars; converted to shares, plausibility-gated |
| SEC EDGAR submissions | 8-K filings as catalyst | authoritative but can lag intraday |
| Nasdaq news by symbol | same-day catalyst | **must** verify the symbol — the API serves unrelated market news as a fallback |
| Nasdaq per-symbol chart | 1-min intraday prices, 04:00–20:00 ET, free | price only, no volume, current day only |
| Databento `XNAS.BASIC` | 1-min OHLCV incl. pre/after-hours, back to 2024-07 | paid per GB; see the dataset trap below |
| Databento `EQUS.SUMMARY` | survivorship-free daily universe + true daily volume | daily bars only |

Stooq was evaluated and rejected: it now sits behind a proof-of-work bot check.
Yahoo Finance endpoints rate-limit shared IPs.

## Known limits

- **Data is end-of-day, not live.** the momentum source's edge is 07:00–11:30 ET on trades
  held under ten minutes. Nothing here is fast enough for that. It builds a
  watchlist, not an entry.
- **Float is the weakest number.** EDGAR files it once a year; small caps
  reverse-split and dilute constantly.
- **Neither trader's results are verified.** the operator
  settled with the FTC in 2022 over deceptive earnings claims; the FTC found
  most customers lost money and returned $2.9M to 20,402 of them.

## Conventions

- TypeScript, run directly via `node --experimental-strip-types`. No build step.
- Commit before each meaningful change.
