/**
 * Push the shortlist to your phone -> ntfy.sh
 *
 * Run:  NTFY_TOPIC=... node --experimental-strip-types scripts/notify.ts
 *
 * ntfy needs no account: you subscribe to a topic in the app and anything
 * published to it arrives as a push. The topic name IS the credential, which is
 * why it lives in a GitHub secret and never in this repository — the repo is
 * public, and a topic in the clear would let anyone read or spam your alerts.
 *
 * Deliberately quiet. A notification for every scan would be a dozen a morning
 * and you would mute it within a week, so it only fires when something needs
 * your eyes: names on the shortlist, or a scan that could not trust its data.
 */
import { readFile } from 'node:fs/promises';

const TOPIC = process.env.NTFY_TOPIC;
if (!TOPIC) { console.log('NTFY_TOPIC not set — skipping notification'); process.exit(0); }

const d = JSON.parse(await readFile('data/premarket.json', 'utf8'));
const url = `https://ntfy.sh/${TOPIC}`;

async function push(title: string, body: string, priority: string, tags: string, click?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Title: title, Priority: priority, Tags: tags,
      ...(click ? { Click: click } : {}),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  console.log(res.ok ? `pushed: ${title}` : `push failed: HTTP ${res.status}`);
}

const site = process.env.SITE_URL ?? '';

// A scan that could not read its feed is more urgent than a quiet one: an empty
// list would otherwise be silently mistaken for "no opportunities today".
if (d.fetch && !d.fetch.reliable) {
  await push(
    'Scan unreliable',
    `Only ${d.fetch.answerRatePct.toFixed(0)}% of quotes answered. Do not read the empty list as "nothing today".`,
    'high', 'warning', site,
  );
} else if (d.shortlist?.length) {
  const lines = d.shortlist.map((r: any) => {
    const bits = [
      `${r.preMarketChangePct >= 0 ? '+' : ''}${r.preMarketChangePct.toFixed(0)}%`,
      `$${r.preMarketPrice.toFixed(2)}`,
      r.relVolume ? `${r.relVolume.toFixed(1)}x vol` : null,
      r.float ? `${(r.float.shares / 1e6).toFixed(1)}M float` : null,
      r.floatRotation ? `${r.floatRotation.toFixed(1)}x rot` : null,
    ].filter(Boolean).join('  ');
    return `${r.symbol}  ${bits}`;
  });
  await push(
    `${d.shortlist.length} on the shortlist`,
    lines.join('\n') + (d.watchlist?.length ? `\n\nwatch: ${d.watchlist.map((r: any) => r.symbol).join(' ')}` : ''),
    'high', 'chart_with_upwards_trend', site,
  );
} else if (d.watchlist?.length) {
  await push(
    'Nothing cleared all five',
    `Watchlist (four of five): ${d.watchlist.map((r: any) => `${r.symbol} ${r.preMarketChangePct >= 0 ? '+' : ''}${r.preMarketChangePct.toFixed(0)}%`).join(', ')}`,
    'default', 'eyes', site,
  );
} else {
  console.log('nothing to report — staying quiet');
}

/**
 * The post-test reminder.
 *
 * The repo was left public only so GitHub Pages could serve it while the data
 * source was unproven. Once a scan has actually read live pre-market quotes,
 * that reason expires — and the moment the result lands is the only moment this
 * reminder is genuinely useful, so it rides along with it rather than sitting
 * in a list nobody opens. It fires once, then marks itself done.
 */
if (d.feedIsLive && d.fetch?.reliable && d.liveQuotes > 0) {
  const { readFile: rf, writeFile } = await import('node:fs/promises');
  let done = false;
  try { done = JSON.parse(await rf('data/reminders.json', 'utf8')).liveFeedConfirmed === true; } catch {}
  if (!done) {
    await push(
      'Live feed confirmed — time to lock it down',
      'The pre-market feed works. Two things now:\n' +
      '1. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as repo secrets\n' +
      '2. Then the repo can go private (this also hides the old commit history)\n' +
      'Buying a domain makes sense from here.',
      'high', 'lock', site,
    );
    await writeFile('data/reminders.json', JSON.stringify({ liveFeedConfirmed: true, at: new Date().toISOString() }));
  }
}
