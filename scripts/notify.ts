/**
 * Post the shortlist as a comment on the tracking issue -> GitHub emails you.
 *
 * Run:  GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo NOTIFY_ISSUE=2 npm run notify
 *
 * Why an issue comment rather than a push service: it needs no app, no account
 * and no subscription — you already receive GitHub email for issues you opened.
 * The web is the whole delivery mechanism.
 *
 * Deliberately quiet. A comment every twenty minutes would be a dozen emails a
 * morning and you would filter them within a week, so it posts only when there
 * is something to act on: names that cleared every criterion, or a scan that
 * could not trust its own data. Quiet mornings send nothing.
 */
import { readFile } from 'node:fs/promises';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const ISSUE = process.env.NOTIFY_ISSUE ?? '2';
const SITE = process.env.SITE_URL ?? '';

/**
 * Telegram is the push channel: a real notification on the phone, with the
 * browser closed, and no new app to install for anyone who already has it.
 *
 * When it is configured it becomes the only channel. GitHub issue comments are
 * kept purely as the fallback, because their delivery mechanism is email and
 * email is what we are moving away from.
 */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const pushConfigured = Boolean(TG_TOKEN && TG_CHAT);

async function telegram(markdown: string): Promise<boolean> {
  if (!pushConfigured) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: markdown,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { console.log(`telegram failed: HTTP ${res.status} ${await res.text()}`); return false; }
    console.log('pushed to Telegram');
    return true;
  } catch (e) {
    console.log(`telegram error: ${(e as Error).message}`);
    return false;
  }
}

const d = JSON.parse(await readFile('data/premarket.json', 'utf8'));

/** Strip the HTML marker and heavy markdown for a phone notification. */
function plain(body: string): string {
  return body
    .replace(/<!--.*?-->/gs, '')
    .replace(/^\s*###\s*/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function comment(body: string) {
  // Telegram is the channel when configured; the issue comment exists only so
  // there is still a record if push is not set up yet.
  if (await telegram(plain(body))) return;
  if (!TOKEN || !REPO) { console.log('no push and no GITHUB_TOKEN — printing instead:\n' + body); return; }
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${ISSUE}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(20_000),
  });
  console.log(res.ok ? 'posted to the tracking issue' : `post failed: HTTP ${res.status} ${await res.text()}`);
}

const when = new Date(d.generatedAt).toLocaleString('en-US', {
  timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
});
const link = SITE ? `\n\n[Open the full page](${SITE})` : '';

// A scan that could not read its feed is more urgent than a quiet one: an empty
// list would otherwise be mistaken for "no opportunities today".
if (d.fetch && d.fetch.requested && !d.fetch.reliable) {
  await comment(
    `### ⚠️ Scan unreliable — ${when} ET\n\n` +
    `Only **${d.fetch.answerRatePct.toFixed(0)}%** of quote lookups answered ` +
    `(${d.fetch.answered} of ${d.fetch.requested}).\n\n` +
    `Do not read the empty shortlist as "nothing today" — the data feed may have failed.${link}`,
  );
} else if (d.shortlist?.length) {
  const rows = d.shortlist.map((r: any) => {
    const cells = [
      `**${r.symbol}**`,
      r.business ?? '—',
      `${r.preMarketChangePct >= 0 ? '+' : ''}${r.preMarketChangePct.toFixed(0)}%`,
      `$${r.preMarketPrice.toFixed(2)}`,
      r.relVolume ? `${r.relVolume.toFixed(1)}×` : '—',
      r.float ? `${(r.float.shares / 1e6).toFixed(1)}M` : '—',
      r.floatRotation ? `${r.floatRotation.toFixed(1)}×` : '—',
      r.catalyst?.subject ?? r.catalyst?.headline?.slice(0, 60) ?? '—',
      r.extended ? '⚠️ extended' : 'day 1',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  await comment(
    `### ${d.shortlist.length} on the shortlist — ${when} ET\n\n` +
    `| Ticker | Business | Move | Price | RVol | Float | Rot | Catalyst | Run |\n` +
    `|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n` +
    (d.watchlist?.length
      ? `Watchlist (four of five): ${d.watchlist.map((r: any) => `\`${r.symbol}\``).join(' ')}\n\n` : '') +
    `_Candidates only. Entry, size and stop are yours._${link}`,
  );
} else {
  console.log('nothing cleared all five — no immediate alert');
}

/**
 * The end-of-morning wrap-up.
 *
 * Silence is ambiguous: a quiet market and a dead pipeline look identical from
 * the outside, and after a few empty mornings you would reasonably start to
 * wonder whether anything was running at all. So the last scan of the window
 * always reports, even when it found nothing — "the pipeline ran, here is what
 * it saw, nothing qualified" is information.
 *
 * Once per day, not once per scan. Twelve heartbeats a morning is spam, and
 * spam gets filtered, which puts us right back where we started.
 */
async function alreadySummarisedToday(marker: string): Promise<boolean> {
  // With Telegram as the channel there are no comments to inspect, so the
  // once-a-day guarantee comes from a committed marker instead.
  if (pushConfigured) {
    try {
      const rf = (await import('node:fs/promises')).readFile;
      return JSON.parse(await rf('data/reminders.json', 'utf8')).lastSummary === marker;
    } catch { return false; }
  }
  if (!TOKEN || !REPO) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/issues/${ISSUE}/comments?per_page=100&page=1`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return false;
    const all: any[] = await res.json();
    // Check the tail; a day's worth of comments is never more than a handful.
    return all.slice(-40).some((c) => String(c.body ?? '').includes(marker));
  } catch { return false; }
}

const nowUtc = new Date();
const utcMins = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
// Generous window, plus a dedicated 15:00 cron as a backstop. GitHub's
// scheduler routinely drifts several minutes under load, and a wrap-up that
// silently fails to fire recreates the exact ambiguity it exists to remove.
// Posting twice is prevented by the marker check, so the window can be wide.
const LAST_SLOT = 14 * 60 + 35;
// FORCE_SUMMARY exists so the wrap-up can be exercised outside the window;
// without it this path is only reachable for about an hour a day.
const isFinalScan = process.env.FORCE_SUMMARY === '1'
  || (utcMins >= LAST_SLOT && utcMins <= 17 * 60);

if (isFinalScan) {
  const today = nowUtc.toISOString().slice(0, 10);
  const marker = `<!--daily-summary:${today}-->`;
  if (await alreadySummarisedToday(marker)) {
    console.log('daily summary already posted today — skipping');
  } else {
    const feed = d.feedIsLive ? 'live pre-market pricing' : 'showing the previous close';
    const answered = d.fetch?.requested
      ? `${d.fetch.answered}/${d.fetch.requested} quote lookups answered (${d.fetch.answerRatePct.toFixed(0)}%)`
      : 'no individual lookups were needed';

    const body = d.shortlist?.length
      ? `${marker}\n### Wrap-up — ${d.shortlist.length} name${d.shortlist.length > 1 ? 's' : ''} today\n\n` +
        `Shortlist: ${d.shortlist.map((r: any) => `**${r.symbol}**`).join(', ')}. Details in the alert above.\n\n` +
        `Pipeline healthy — ${d.universeChecked.toLocaleString()} symbols scanned, feed ${feed}.${link}`
      : `${marker}\n### Nothing to trade today\n\n` +
        `**The pipeline ran and found no candidates.** That is a result, not a fault.\n\n` +
        `- ${d.universeChecked.toLocaleString()} symbols scanned\n` +
        `- ${(d.smallCapsInBand ?? 0).toLocaleString()} of them small caps in the price band\n` +
        `- ${(d.investigated ?? 0).toLocaleString()} movers investigated individually\n` +
        `- ${answered}\n` +
        `- Nasdaq reported the market as **${d.marketStatus ?? 'unknown'}**, feed ${feed}\n` +
        (d.watchlist?.length
          ? `- Closest misses: ${d.watchlist.slice(0, 5).map((r: any) => `\`${r.symbol}\``).join(' ')}\n`
          : `- Nothing even reached four of five criteria\n`) +
        `\nA full scan usually leaves fewer than ten names, and some mornings none.${link}`;

    await comment(body);
    if (pushConfigured) {
      const { readFile: rf, writeFile } = await import('node:fs/promises');
      let state: any = {};
      try { state = JSON.parse(await rf('data/reminders.json', 'utf8')); } catch {}
      state.lastSummary = marker;
      await writeFile('data/reminders.json', JSON.stringify(state));
    }
  }
}

/**
 * One-shot reminder, riding along with the first scan that reads a live feed —
 * the moment the reason for keeping this repo public expires.
 */
if (d.feedIsLive && d.fetch?.reliable && d.liveQuotes > 0) {
  const { readFile: rf, writeFile } = await import('node:fs/promises');
  let done = false;
  try { done = JSON.parse(await rf('data/reminders.json', 'utf8')).liveFeedConfirmed === true; } catch {}
  if (!done) {
    await comment(
      `### ✅ Live pre-market feed confirmed\n\n` +
      `A scan has now read real live pre-market quotes, so the reason this repo is public has expired.\n\n` +
      `1. Add \`CLOUDFLARE_API_TOKEN\` and \`CLOUDFLARE_ACCOUNT_ID\` as repository secrets — the deploy step activates on its own\n` +
      `2. Then flip the repo **private**; Cloudflare serves from private repos and this also hides the old commit history\n` +
      `3. A domain makes sense from here\n\nSee #1.`,
    );
    await writeFile('data/reminders.json', JSON.stringify({ liveFeedConfirmed: true, at: new Date().toISOString() }));
  }
}
