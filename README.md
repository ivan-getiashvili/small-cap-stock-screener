# Small Cap Stock Screener

A daily **pre-market shortlist** of small-cap momentum candidates, screened on the
published criteria of Ross Cameron (Warrior Trading) and Tim Sykes.

It finds candidates. It does not decide anything — entry, size and stop are yours.

## The five criteria

Up **≥10% pre-market** · pre-market volume **≥50k** · a real **news catalyst** ·
price **$2–$20** · float **under 10M shares**. All five must pass to reach the shortlist.

Sourced from Cameron's gapper checklist and quality tiers, and Sykes' pre-market
routine — percent gainers first, then catalyst and float, ending with one to five
names rather than twenty. Citations in `docs/CRITERIA.md`.

## Running it

```bash
cp .env.example .env.local   # then fill in SEC_USER_AGENT
npm run site                 # scan + build -> _site/index.html
npm run serve                # http://localhost:4188
```

The scan is meaningful only during the pre-market session (04:00–09:30 ET);
outside it the page says so rather than showing stale prices as if they were live.

## What else is in here

`npm run build:research` builds a second page with the end-of-day screener and the
minute-resolution backtests. Read `CLAUDE.md` before trusting any of those numbers —
the short version is that the setup's edge dies somewhere between 1c and 2c of
slippage per side, and a $2,000 account is too small to hold the trades that carry it.
