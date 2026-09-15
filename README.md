# Small Cap Stock Screener

A daily **pre-market shortlist** of small-cap momentum candidates, screened on five
published momentum criteria.

It finds candidates. It does not decide anything — entry, size and stop are yours.

## The five criteria

Up **≥10% pre-market** · pre-market volume **≥50k** · a real **news catalyst** ·
price **$2–$20** · float **under 10M shares**. All five must pass to reach the shortlist.

Percent gainers are ranked first, then catalyst and float, ending with a handful of
names rather than twenty. The percentage is **this session** against the previous
close — names that have already run for several sessions are flagged as extended.

## The track record

Every name the list showed is scored after the close on the session it was
flagged for, measured from the pre-market price shown at the time: how far it
ran to the high of the day, and where it opened, stood at noon and closed.
Nothing is filtered out. The record is honest about what these stocks do: they
move a great deal, and most of the move is behind you by the time a screen can
see it. See `CLAUDE.md` for the two years of tests behind that sentence.

## Running it

```bash
cp .env.example .env.local   # then fill in SEC_USER_AGENT
npm run site                 # scan + build -> _site/index.html
npm run serve                # http://localhost:4188
```

The scan is meaningful only during the pre-market session (04:00–09:30 ET);
outside it the page says so rather than showing stale prices as if they were live.

## How it runs on its own

- **Scans** are the GitHub Actions workflow `premarket.yml`: every 20 minutes
  through pre-market, a backstop at 15:00 UTC, and the closing snapshot at 21:10
  UTC. Each run commits the scan and the track record, then publishes the page.
- **The clock** is a Cloudflare Worker (`worker/index.ts`): GitHub's own schedule
  started 2 of 14 runs on the first live day, so the Worker's cron triggers start
  the workflow through GitHub's API instead. It needs one secret,
  `GITHUB_DISPATCH_TOKEN` (a fine-grained token with *Actions: read and write* on
  this repository), added in the Cloudflare dashboard.
- **The site** is served by the same Worker from `_site/`, built by
  `npm run build:pages` from the committed JSON. Connect the repository in the
  Cloudflare dashboard (Workers & Pages → Create → import from GitHub) with build
  command `npm ci && npm run build:pages`, deploy command `npx wrangler deploy`
  and `NODE_VERSION=24`; every scan commit then republishes the page. GitHub
  Pages serves it until then, at
  https://ivan-getiashvili.github.io/small-cap-stock-screener/.

## What else is in here

`npm run build:research` builds a second page with the end-of-day screener and the
minute-resolution backtests. Read `CLAUDE.md` before trusting any of those numbers —
the short version is that the setup's edge dies somewhere between 1c and 2c of
slippage per side, and a $2,000 account is too small to hold the trades that carry it.

`npm run demo` rebuilds `_site/demo.html`, a replay of one real past morning so the
layout can be seen without waiting for a live session.
