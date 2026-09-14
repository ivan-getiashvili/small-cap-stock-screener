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

## Track record (`data/history.json`, `lib/history.ts`)

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

## Session strategies compared (2026-09-14, `npm run strategies`)

Ivan asked whether the method is "buy pre-market, sell after the open" and how
simple holds compare. `scripts/session-strategies.ts` answers on every stock the
08:45 gate would have flagged (up 10%+, 50k+ shares, $2–$20, funds excluded):
530 sessions Aug 2024 – Sep 2026, 4,834 stock-days, pre-market buys at the real
ask and noon/stop sells at the real bid (`cbbo-1m`), ~$3 of Databento credit.
Results in `data/strategies.json`; 20 trades recomputed independently match.

| strategy | won | median | mean |
|---|---|---|---|
| pre-market (08:45) → open | 35% | −1.2% | −1.2% |
| pre-market → close | 37% | −4.0% | −1.7% |
| open → noon | 39% | −2.6% | −1.5% |
| open → close | 41% | −2.5% | −0.6% |
| open, 5 / 10 / 20% trailing stop | 33–40% | −2.2 to −3.0% | −0.7 to −0.8% |

Every hold loses on average, in each of the three years. The move (median +46%
previous close → high) happens before 08:45 and then fades. Neither trader holds
across the open: the momentum source trades minutes-long bursts 07:00–11:00 ET,
the scoring source buys morning spikes and panic dips in the session. This is the
broad gate, not the strict shortlist (catalyst + float), which was not replayed.

How the sample stays honest: candidates are preselected from daily bars (opened
up 2%+, or traded 10% up, or 3× 20-day volume — the volume path catches names
that spiked pre-market and died before the bell), and the run stops if that
preselection drops any name the all-symbol replay flagged (71/71 kept). The
earlier `data/db/minutes` cache selected on the day's HIGH and missed 25 of 71
real gappers, mostly pre-open fades; never reuse it for pre-market questions.

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
