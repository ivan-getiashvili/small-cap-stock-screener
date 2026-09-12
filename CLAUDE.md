# Small Cap Stock Screener

An intraday small-cap momentum screener built on the published criteria of two
day traders: **Ross Cameron** (Warrior Trading) and **Tim Sykes**.
Owner: Ivan. Beginner at web dev — explain concepts when introducing them.

Completely separate from the BTC dashboard project. Nothing is shared.

## What it does

1. **Screens** the whole US market (~6,000 stocks) against Cameron's five
   pass/fail pillars, then ranks survivors with Sykes' 100-point sliding scale.
2. **Backtests** the mechanical part of that filter over cached daily history.
3. **Paper-trades** its own picks forward, committing before the session and
   scoring afterwards, so the record cannot be tuned with hindsight.

## The finding that matters

The backtest is negative. Over 3,524 historical signals, **every exit rule
tested lost money**, and a $2,000 account on Cameron's own stop-and-target was
blown out in five weeks. Survivorship bias makes that test *optimistic* and it
is still negative.

The reason is visible in two numbers: next-day open→close median **−1.67%**,
but open→high median **+6.32%**. The spike is real and then given back. What is
missing from the mechanical filter is exactly what both men emphasise — the
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
npm run ingest        # scan the market -> data/screen.json
npm run build         # bake into _site/index.html
npm run build:site    # both
npm run backtest      # needs history cached first
npm run paper         # advance the paper account (run after the close)
node --experimental-strip-types scripts/fetch-history.ts   # cache bars (~5 min)
```

`SEC_USER_AGENT` must be set — EDGAR returns 403 without a contact string.
Put it in `.env.local` (gitignored).

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
6. **Never make the backtest look better than it is.** When a daily bar covers
   both stop and target, always assume the stop hit first, and report what
   share of results rest on that assumption.

## Data sources (all free, all keyless)

| Source | Used for | Note |
|---|---|---|
| Nasdaq screener API | whole-market price, % change, volume, market cap | `download=true` is what adds the volume column |
| Nasdaq per-symbol history | daily OHLCV — relative volume, gaps, backtest | ~0.5 s per symbol |
| SEC EDGAR `dei:EntityPublicFloat` | float | annual, in dollars; converted to shares, plausibility-gated |
| SEC EDGAR submissions | 8-K filings as catalyst | authoritative but can lag intraday |
| Nasdaq news by symbol | same-day catalyst | **must** verify the symbol — the API serves unrelated market news as a fallback |

Stooq was evaluated and rejected: it now sits behind a proof-of-work bot check.
Yahoo Finance endpoints rate-limit shared IPs.

## Known limits

- **Data is end-of-day, not live.** Cameron's edge is 07:00–11:30 ET on trades
  held under ten minutes. Nothing here is fast enough for that. It builds a
  watchlist, not an entry.
- **Float is the weakest number.** EDGAR files it once a year; small caps
  reverse-split and dilute constantly.
- **Neither trader's results are verified.** Warrior Trading and Ross Cameron
  settled with the FTC in 2022 over deceptive earnings claims; the FTC found
  most customers lost money and returned $2.9M to 20,402 of them.

## Conventions

- TypeScript, run directly via `node --experimental-strip-types`. No build step.
- Commit before each meaningful change.
