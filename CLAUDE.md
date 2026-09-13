# Small Cap Stock Screener

An intraday small-cap momentum screener built on the published criteria of two
day traders: **Ross Cameron** (Warrior Trading) and **Tim Sykes**.
Owner: Ivan. Beginner at web dev — explain concepts when introducing them.

Completely separate from the BTC dashboard project. Nothing is shared.

## What it does

**The product is one page: a pre-market shortlist of small caps, published
before the open.** Everything else is supporting research.

- `_site/index.html` — the shortlist. Built by `npm run site`, refreshed by CI
  every 20 minutes through the pre-market window.
- `_site/research.html` — the end-of-day screener and the backtests.

## The pre-market scan, and why it is shaped this way

**One bulk request, then ~30 lookups.** The first version asked Nasdaq for a
quote on every one of ~2,945 small caps — roughly 35,000 requests a day on the
schedule — and Nasdaq began answering 403 after two runs. That failure mode is
nastier than it sounds: a blocked feed yields an empty shortlist, which looks
identical to a quiet morning. So the scan takes the whole market in one request,
then investigates only the names that survive the first cut.

**Staleness is measured, not assumed.** A post-close job records every closing
price to `data/prevclose.json`, and the morning scan measures the pre-market
move against that itself rather than trusting a vendor's percent-change field to
have rolled over. If prices match the stored closes, the page says the feed is
not live instead of reporting "nothing qualified".

**The answer rate is published.** If fewer than half the quote lookups respond,
the page says the scan is unreliable and CI fails during pre-market. An empty
list must never be able to mean two different things silently.

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
# the product
npm run site          # pre-market scan + build -> _site/index.html
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
