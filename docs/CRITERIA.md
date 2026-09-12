# Source criteria — Cameron and Sykes

Extracted from their own videos and sites, September 2026. Every threshold in
`lib/screen.ts` traces back to a line here. Where their own sources disagree,
both figures are recorded rather than silently reconciled.

## Ross Cameron — five pillars (pass/fail)

Primary source: ["Picking Stocks was HARD Until I Learned This 5 Step Trick"](https://www.youtube.com/watch?v=Zdr4n8RSOmQ),
22 Oct 2025. He states these are derived from mining his own trade history.

| # | Criterion | Threshold | His words |
|---|---|---|---|
| 1 | % change on day | ≥ 10% already | "has to be up at least 10% on the day already before I'm even going to look at it" |
| 2 | Relative volume | ≥ 5× the 50-day average | "over 90% of my profit comes from stocks that have 5x higher relative volume" |
| 3 | News catalyst | required | "what comes first is definitely the news catalyst" |
| 4 | Price | $2 – $20 | "I have made more money on stocks between 2 and 20" |
| 5 | Float | < 10M shares | "under 10 million shares"; occasionally stretches to 15–20M |

Supporting, same video plus ["Growing a $2k Account to $65,662.04 in 30 Days"](https://www.youtube.com/watch?v=xGIa8Vg0PWM) (5 Aug 2026):

- Pre-market gap **≥ 2%** above prior close
- Total volume potential **≥ 25M shares** by day's end
- Window **07:00–11:00 ET**, sweet spot 07:00–09:30; news lands at 08:00, 08:30, 09:00
- Most profit from trades held **under 10 minutes**
- RVOL > 20 narrows the entire market to roughly **20 stocks a day**

Supply/demand mechanic, in his own worked example: MLGO, ~797k float, 300M
shares traded, +400%. He reasons a 10M float on the same volume gives ~40%, a
500k float ~800%.

### Trade management
From [warriortrading.com/momentum-day-trading-strategy](https://www.warriortrading.com/momentum-day-trading-strategy/) (updated 9 Jan 2025) and [Gap and Go](https://www.warriortrading.com/gap-go/):

- Patterns: **bull flag**, **flat top breakout**. Bull flag entry = first candle
  to make a new high after a 2–3 red-candle pullback; stop at the pullback low.
  A valid pullback **does not retrace more than 50%**.
- Gap and Go (09:30–10:00 only): scan gaps **> 4%**, confirm catalyst, mark
  pre-market highs, buy the high of the first 1-minute candle.
- Stop: below the first pullback; if further than **20 cents**, use 20 cents.
- **2:1** profit/loss ratio. Position size = max risk ÷ stop distance
  ($500 ÷ $0.20 = 2,500 shares).
- Exits: sell ½ at target then breakeven stop; first red candle close;
  sell into an extension bar; **MACD negative on the 1-min chart ends the leg**.

### Inconsistency to be aware of
His **website** is looser than his 2025 video: float under **100M** (ideal
under 20M), RVOL only **2×**, price **under $10** on the penny-stock page. The
video figures are the ones implemented, because he says they came from his P&L.
He also states he **avoids OTC and pink sheets entirely** — NASDAQ/NYSE only.

## Tim Sykes — the Sliding Scale (weighted score)

Primary source: ["How to Pick Stocks to Day Trade (with my 7-Step Formula)"](https://www.youtube.com/watch?v=hiKZvya9QIA),
9 Nov 2025 — the video where he gives the actual point weights.

| Indicator (P.R.E.P.A.R.E.) | Weight | Scores 1 | Scores max |
|---|---|---|---|
| **P**attern and price | 1–20 | far from his sweet spot | $3–$5, morning panic / morning spike / first green day |
| **R**isk/reward | 1–20 | 1:1 | 10:1 — make 50c–$1, risk 5–10c |
| **E**ase of entry/exit | 1–10 | 20–30c spread | 1c spread, millions of shares |
| **P**ast performance / spiking | 1–10 | never spiked | ran 100–500% before |
| **A**t what time / schedule | 1–20 | midday ~2pm, or you're busy | near the open, schedule clear |
| **R**eason / catalyst | 1–10 | chatroom or social hype | real news, small co legitimised by a big partner |
| **E**nvironment of market | 1–10 | few big gainers | half a dozen stocks already up 100%+ |

**Total 7–100. He trades only above 70.**

### Screening mechanics
From ["How to Scan for Small Cap Stocks"](https://www.youtube.com/watch?v=3ZM9LNU9TOw) (3 Jan 2026) and ["The Pre-Market Checklist"](https://www.youtube.com/watch?v=nft63lDEwJ0) (27 Jul 2026):

- Universe: **stocks under $20**, sorted by biggest % gainers. He starts with
  the gainer list, deliberately *not* with the news.
- Float: wants **500k–5M shares**. Graded on camera: 21M acceptable,
  **94M rejected** ("if this were 9 million shares or 900,000 shares, I would be
  much more interested"), 48M biotech rejected.
- **Float rotation = volume ÷ float** is his central metric. Praised GSIT at
  21M float trading 115M shares ≈ "five or six times the float rotation".
  Cites **3×** as the level where supply runs out.
- Volume **5–50M shares/day**; volume must confirm — "up 40% on 10 million
  shares is very different than up 40% on 50 or 100,000 shares".
- **21% is "not up enough really for me"**.
- Excludes **warrants** (tickers ending W) and **biotechs** — the direct
  opposite of Cameron, who trades biotech FDA news as a favourite.
- **Day one only**; avoids day 2/3 as "overextended or crowded".
- Final watchlist is **1 to 5 names**.
- Levels pre-set: **pre-market high and two-day high**. Max loss **1–3%**, 5% ceiling.
- Three-part filter, verbatim: **"breaking news + volume + predictable patterns"**.

### His blog differs from his video
[Blog screener settings](https://www.timothysykes.com/blog/momentum-stock-screener/): price **$0.50–$5.00**,
min daily volume **500,000**, RVOL **≥ 2×**, up **10–30%**, pre-market **10%+**,
RSI **> 60**, market cap **under $300M**. The video says his sweet spot is $3–$5.

### Lifecycle map
[7-step pennystocking framework](https://www.timothysykes.com/blog/7-step-pennystocking-framework/): pre-pump → ramp →
**supernova (buy)** → cliff dive → **dip buy (buy, his stated favourite for
small accounts)** → dead pump bounce → long kiss goodnight. He now advises
**against shorting**.

## Where they disagree

| | Cameron | Sykes |
|---|---|---|
| Price sweet spot | $2–$20 | $3–$5 (video) / $0.50–$5 (blog) |
| Float | < 10M | 500k–5M, hard reject near 100M |
| RVOL | ≥ 5× explicit | ≥ 2× (blog); prefers rotation instead |
| Biotech | favourite | avoids |
| OTC / pink sheets | refuses entirely | trades them |
| Core metric | relative volume | volume ÷ float |
| Decision style | 5 hard filters | 7 weighted scores, threshold 70 |

This is why the implementation uses Cameron as the **filter** and Sykes as the
**ranker** — the two systems compose without either being watered down.

## Reliability

All performance figures are self-reported. Warrior Trading and Ross Cameron
[settled with the FTC in April 2022](https://www.ftc.gov/news-events/news/press-releases/2022/04/federal-trade-commission-cracks-down-warrior-trading-misleading-consumers-false-investment-promises)
for $3M over deceptive earnings claims; the FTC found the vast majority of
customers lost money and [returned $2.9M to 20,402 people](https://www.ftc.gov/news-events/news/press-releases/2023/01/ftc-returns-more-29-million-consumers-harmed-warrior-trading).
Cameron himself writes "most beginning day traders will lose money"; Sykes
repeats "90% of traders lose".
