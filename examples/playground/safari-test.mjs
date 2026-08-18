/**
 * The same suite, in REAL Safari — not Playwright's WebKit.
 *
 * Playwright bundles its own WebKit build. It is close to Safari and it is what
 * CI runs, but it is not the browser anyone actually ships to: Apple's build has
 * different OPFS quotas, different storage eviction, and lags or leads on
 * features by months. "Tested on WebKit" and "works in Safari" are two claims,
 * and only one of them was ever true here.
 *
 * Driven over raw WebDriver with fetch, deliberately — selenium-webdriver is a
 * dependency this repo would otherwise never need, for a script that runs by
 * hand a few times a release.
 *
 *   node examples/playground/safari-test.mjs
 *
 * ONE-TIME SETUP, and it needs a human at the keyboard — but not an admin
 * password, as long as you use the GUI:
 *
 *   1. Safari > Settings > Advanced > tick "Show features for web developers"
 *   2. a "Developer" tab appears in Settings > tick "Allow remote automation"
 *
 * On Safari 16 and earlier that second switch lived in the Develop MENU instead.
 * `sudo safaridriver --enable` does the same thing from a terminal and does ask
 * for a password, which is why it is not run from here.
 *
 * Without it every session is refused; this reports Safari's own message as-is.
 */
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = 4599;
const DRIVER = `http://localhost:${PORT}`;

const PAGES = [
  { path: '/?phase=fresh', name: 'main (fresh)' },
  { path: '/?phase=reload', name: 'main (reload)' },
  { path: '/compat.html', name: 'compat + Dexie migration' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(DRIVER + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.value?.error) throw new Error(json.value.message || json.value.error);
  return json.value;
}

const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

const driver = spawn('safaridriver', ['-p', String(PORT)], { stdio: 'ignore' });
const shutdown = async () => { driver.kill(); await server.close(); };

// safaridriver takes a moment to bind; poll rather than guess a sleep.
let up = false;
for (let i = 0; i < 20 && !up; i++) {
  await sleep(250);
  up = await fetch(`${DRIVER}/status`).then((r) => r.ok).catch(() => false);
}
if (!up) { console.error('safaridriver never came up on port ' + PORT); await shutdown(); process.exit(1); }

let session;
try {
  session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
} catch (err) {
  console.error(`\nReal Safari could not be driven:\n  ${err.message}\n`);
  console.error('Enable it once, by hand. No password needed via the GUI:');
  console.error('  1. Safari > Settings > Advanced > tick "Show features for web developers"');
  console.error('  2. a "Developer" tab appears in Settings > tick "Allow remote automation"');
  console.error('     (Safari 16 and earlier: the Develop MENU > "Allow Remote Automation")');
  console.error('\nThen re-run this. Quit and reopen Safari first if it was already running.\n');
  await shutdown();
  process.exit(2);
}

const sid = session.sessionId;
console.log(`— real Safari ${session.capabilities?.browserVersion ?? ''} —`);

let failed = 0;
for (const { path, name } of PAGES) {
  await wd('POST', `/session/${sid}/url`, { url: base + path });

  let res = null;
  // A cold sqlite-wasm compile is slow; poll rather than one long execute.
  for (let i = 0; i < 240 && res == null; i++) {
    await sleep(500);
    res = await wd('POST', `/session/${sid}/execute/sync`, {
      script: 'return window.__RESULTS__ ?? null;',
      args: [],
    }).catch(() => null);
  }

  if (!res) {
    failed++;
    console.error(`FAIL  ${name} — timed out waiting for __RESULTS__`);
  } else if (res.fatal) {
    failed++;
    console.error(`FAIL  ${name} — ${res.fatal}`);
  } else if (res.failed) {
    failed += res.failed;
    console.error(`FAIL  ${name} — ${res.failed} of ${res.total}`);
    for (const r of res.results.filter((x) => !x.ok)) console.error(`        ${r.name} — ${r.detail}`);
  } else {
    console.log(`PASS  ${name} — ${res.total}/${res.total}`);
  }
}

await wd('DELETE', `/session/${sid}`).catch(() => {});
await shutdown();
console.log(failed ? `\n${failed} FAILURE(S) in real Safari` : `\nreal Safari: every check passed`);
process.exit(failed ? 1 : 0);
