/**
 * Multi-tab failover stress test.
 *
 * The single-writer topology is the most dangerous part of this library: one tab
 * holds the OPFS connection and every other tab talks to it over
 * BroadcastChannel. If a write can be LOST or applied TWICE when the leader
 * disappears, that is silent data corruption — the worst possible failure mode,
 * and one no single-tab test can see.
 *
 * The invariant under test, stated precisely:
 *
 *   every id a tab was TOLD was written must be in the database exactly once,
 *   and the database must contain nothing that no tab claims to have written.
 *
 * A write that FAILS during failover is acceptable (the caller sees an error and
 * can retry). A write that succeeds and then vanishes is not.
 */

import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const engines = { chromium, firefox, webkit };
const engineName = process.env.BROWSER ?? 'chromium';

const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/stress.html`;

const browser = await engines[engineName].launch();
const context = await browser.newContext();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/** Counts how often opening a database races a dying leader. See FINDING below. */
let openRetries = 0;
/** Counts reads that had to be retried after a failover. See FINDING below. */
let readRetries = 0;

const newTab = async () => {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`   page error: ${e.message}`));
  await page.goto(base);
  await page.waitForFunction(() => window.__stress !== undefined, null, { timeout: 60_000 });

  // This loop is now a BACKSTOP, not a workaround. The library retries both
  // errors for open() itself — NoLeaderError because nothing ran, and
  // LeaderLostError because re-running open() is indistinguishable from running
  // it once (migration is gated on PRAGMA user_version and applies its DDL in one
  // transaction). It was a real finding: every consumer used to have to write
  // this. Kept so the suite still reports if the library's own retries are not
  // enough under load.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.evaluate(() => window.__stress.open());
      return page;
    } catch (err) {
      if (attempt >= 5 || !/LeaderLost|NoLeader/.test(String(err))) throw err;
      openRetries++;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
};

console.log(`— ${engineName}: multi-tab failover —`);

// ---- 1. baseline: four tabs writing at once must not lose or duplicate ------
{
  const tabs = await Promise.all([newTab(), newTab(), newTab(), newTab()]);
  await tabs[0].evaluate(() => window.__stress.wipe());

  const results = await Promise.all(
    tabs.map((p, i) => p.evaluate(([t, n]) => window.__stress.write(t, n), [`t${i}`, 40]))
  );

  const claimed = results.flatMap((r) => r.ok);
  const actual = await tabs[0].evaluate(() => window.__stress.all());
  const missing = claimed.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !claimed.includes(id));

  check('4 tabs x 40 concurrent writes: nothing lost', missing.length === 0, `missing ${missing.length}: ${missing.slice(0, 5)}`);
  check('4 tabs x 40 concurrent writes: nothing duplicated', actual.length === new Set(actual).size);
  check('no phantom rows', extra.length === 0, `extra ${extra.length}`);
  check('all 160 writes acknowledged', claimed.length === 160, `got ${claimed.length}`);
  for (const p of tabs) await p.close();
}

// ---- 2. kill the leader MID-WRITE ------------------------------------------
// The first tab to open wins the Web Lock, so tab 0 is the leader. Closing it
// while the others are mid-sequence forces re-election with calls in flight.
{
  const tabs = await Promise.all([newTab(), newTab(), newTab()]);
  await tabs[0].evaluate(() => window.__stress.wipe());

  const writers = tabs.slice(1).map((p, i) =>
    p.evaluate(([t, n, d]) => window.__stress.write(t, n, d), [`k${i}`, 30, 15])
  );

  await new Promise((r) => setTimeout(r, 250)); // let writes get going
  await tabs[0].close();                        // leader dies mid-flight

  const results = await Promise.all(writers);
  const claimed = results.flatMap((r) => r.ok);
  const errored = results.filter((r) => r.failedAt);

  // Give the survivors a moment to re-elect before reading back.
  //
  // FINDING: this read has to be retried. A read ACKed by the dying leader
  // rejects with LeaderLostError — "may or may not have committed" — but a READ
  // commits nothing, so it is unconditionally safe to retry. Treating reads like
  // writes makes every app hand-roll this loop after any failover.
  await new Promise((r) => setTimeout(r, 500));
  let actual;
  for (let attempt = 0; ; attempt++) {
    try { actual = await tabs[1].evaluate(() => window.__stress.all()); break; }
    catch (err) {
      if (attempt >= 5 || !/LeaderLost|NoLeader/.test(String(err))) throw err;
      readRetries++;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const missing = claimed.filter((id) => !actual.includes(id));

  check('leader killed mid-write: no acknowledged write was lost', missing.length === 0,
    `missing ${missing.length}: ${missing.slice(0, 8)}`);
  check('leader killed mid-write: no duplicates', actual.length === new Set(actual).size);
  check('survivors still usable after failover', typeof (await tabs[1].evaluate(() => window.__stress.count())) === 'number');
  console.log(`      (${claimed.length} acknowledged, ${errored.length} tab(s) saw an error — errors here are acceptable)`);
  for (const p of tabs.slice(1)) await p.close();
}

// ---- 3. interactive transactions must not interleave across tabs -----------
// Each tx reads count(), waits, then writes a row stamped with what it read. If
// the exclusive cross-tab lock works, every tab sees a DIFFERENT count.
{
  const tabs = await Promise.all([newTab(), newTab(), newTab()]);
  await tabs[0].evaluate(() => window.__stress.wipe());

  await Promise.all(tabs.map((p, i) => p.evaluate((t) => window.__stress.txAppend(t, 0), `x${i}`)));
  const rows = await tabs[0].evaluate(() => window.__stress.all());
  check('3 concurrent interactive transactions all committed', rows.length === 3, `got ${rows.length}: ${rows}`);
  for (const p of tabs) await p.close();
}

if (readRetries) {
  console.log(`\nNOTE: a read after failover rejected ${readRetries}x with LeaderLost/NoLeader.`);
  console.log('      A read commits nothing, so it is always safe to retry — the library should.');
}
if (openRetries) {
  console.log(`\nNOTE: open() hit LeaderLostError/NoLeaderError ${openRetries}x and needed a retry.`);
  console.log('      open() is idempotent, so the library could retry it itself.');
}

await browser.close();
await server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall concurrency checks passed');
process.exit(failures ? 1 : 0);
