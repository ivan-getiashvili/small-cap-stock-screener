/**
 * Build every page from the committed JSON -> _site/
 *
 * Run:  npm run build:pages
 *
 * No scanning, no network, no secrets: this is what CI runs after a scan and
 * what Cloudflare's Workers Builds runs on every push, so both produce the
 * same site from the same files. The replay demo and the research page are
 * only built when their data is present.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const build = (script: string) => execFileSync('node', ['--experimental-strip-types', script], { stdio: 'inherit' });

build('scripts/build-premarket.ts');
if (existsSync('data/demo.json')) build('scripts/build-demo.ts');
if (existsSync('data/screen.json')) build('scripts/build-page.ts');
