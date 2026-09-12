# Small Cap Stock Screener

Screens the US market for the intraday momentum setups described by Ross
Cameron and Tim Sykes, backtests them, and paper-trades its own picks.

- `docs/CRITERIA.md` — the source criteria, with citations
- `CLAUDE.md` — architecture, rules, commands

```bash
echo 'SEC_USER_AGENT="your name your@email"' > .env.local
node --experimental-strip-types scripts/fetch-history.ts   # once, ~5 min
npm run build:site && npm run backtest && npm run paper
npm run serve   # http://localhost:4188
```

**The backtest is negative.** Every exit rule tested lost money over 3,524
signals. Read the Known limits section of `CLAUDE.md` before trading anything
this produces.
