/**
 * The site's home on Cloudflare, and the clock that starts each scan.
 *
 * - The page is static: `npm run build:pages` bakes the JSON the scans commit
 *   into _site/, and the assets binding serves that directory. The fetch handler
 *   only passes requests through to it.
 * - The cron triggers replace GitHub's own schedule, which started 2 of the 14
 *   runs it was asked for on 2026-09-14. At each tick the Worker starts the
 *   `premarket.yml` workflow through GitHub's API (workflow_dispatch): a scan,
 *   or the closing snapshot on the 21:10 UTC tick. Both timers may fire; the
 *   workflow's concurrency group lets the later run win, and a scan is
 *   idempotent.
 * - GITHUB_DISPATCH_TOKEN is a Worker secret: a fine-grained GitHub token with
 *   "Actions: read and write" on this repository only, added by Ivan in the
 *   Cloudflare dashboard. Without it the Worker serves the site and starts
 *   nothing, and says so in its logs.
 */
type Fetcher = { fetch(request: Request): Promise<Response> };
type ScheduledEvent = { cron: string; scheduledTime: number };
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export interface Env {
  ASSETS: Fetcher;
  GITHUB_REPO: string;
  GITHUB_DISPATCH_TOKEN?: string;
  /** Set in .dev.vars for a local run: log the request instead of sending it. */
  DRY_RUN?: string;
}

export default {
  fetch: (request: Request, env: Env) => env.ASSETS.fetch(request),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatch(env, event.cron));
  },
};

/** Start the workflow for this cron tick. Returns a one-line outcome for the logs. */
export async function dispatch(env: Env, cron: string): Promise<string> {
  const mode = cron.startsWith('10 21') ? 'snapshot' : 'scan';
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/premarket.yml/dispatches`;
  let outcome: string;
  if (env.DRY_RUN) outcome = `dry run: would start ${mode} via ${url}`;
  else if (!env.GITHUB_DISPATCH_TOKEN) outcome = `GITHUB_DISPATCH_TOKEN is not set: ${mode} not started`;
  else {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'smallcap-premarket-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode } }),
    });
    outcome = res.status === 204 ? `${mode} started` : `${mode} NOT started: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  }
  console.log(`[${cron}] ${outcome}`);
  return outcome;
}
