/**
 * Two-tab failover.
 *
 * This deserves its own file because two tabs behave DIFFERENTLY from three or
 * more, and the three-tab stress test was green while this was broken. With two
 * tabs the survivor elects ITSELF, and a BroadcastChannel never delivers to its
 * own sender — so every path that depends on hearing `elected` from somebody
 * else is skipped.
 *
 * That is how schema loss on failover hid: schema lives in the LEADER's engine,
 * not in the file, and a newly elected worker has never run migrate(). The
 * client cached `_opened` against the old leader and never re-sent open(), so
 * every call failed with `no table "rows". Declared: (none)`.
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

const tab = async () => {
  const p = await context.newPage();
  p.on('pageerror', (e) => console.error(`   page error: ${e.message}`));
  await p.goto(base);
  await p.waitForFunction(() => window.__stress !== undefined, null, { timeout: 60_000 });
  for (let i = 0; ; i++) {
    try { await p.evaluate(() => window.__stress.open()); return p; }
    catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 150)); }
  }
};

console.log(`— ${engineName}: two-tab failover —`);

const A = await tab();  // opens first, wins the lock, is the leader
const B = await tab();
await A.evaluate(() => window.__stress.wipe());

const pending = B.evaluate(() => window.__stress.write('B', 5, 40));
await new Promise((r) => setTimeout(r, 60));
await A.close();        // the leader dies with B's call in flight

const settled = await Promise.race([
  pending.then((r) => r, (e) => ({ ok: [], error: String(e) })),
  new Promise((r) => setTimeout(() => r({ ok: [], error: 'HUNG: never settled after 15s' }), 15_000)),
]);
// The invariant is NOT "all five writes succeed". A write the dying leader had
// already ACKed has genuinely unknown commit state, and the ACK-before-run
// contract says it must surface rather than be silently retried — that is the
// design, not a defect. An earlier version of this asserted 5/5 and passed
// locally three times purely because no write happened to be in flight at the
// moment of death; CI's timing caught one and failed. The test was encoding a
// guarantee the library deliberately does not make.
//
// What must hold: the call SETTLES (no hang), and if it failed it failed loudly.
// Match the MESSAGE, not the class name: the write helper reports
// String(err.message), so the text is "leader died while running ..." and a
// /LeaderLost/ regex silently never matched — which is how this still failed
// after the invariant was corrected.
const EXPECTED_FAILOVER = /leader died|no leader|LeaderLost|NoLeader/i;
const acceptable =
  settled.ok.length === 5 || (settled.error && EXPECTED_FAILOVER.test(settled.error));
check('B settles rather than hanging when the leader dies', acceptable,
  `wrote ${settled.ok.length}/5, error: ${settled.error ?? 'none'}`);
check('a failure during failover is loud, never a silent loss',
  settled.ok.length === 5 || Boolean(settled.error),
  'a write neither succeeded nor reported an error');

// The schema check: a newly elected leader must re-run the migration.
const afterwards = await Promise.race([
  B.evaluate(() => window.__stress.count()).then((n) => `count=${n}`, (e) => `threw: ${String(e).slice(0, 90)}`),
  new Promise((r) => setTimeout(() => r('HUNG after 15s'), 15_000)),
]);
check('the new leader has the schema (no "Declared: (none)")', afterwards.startsWith('count='), afterwards);

// A hung call would hold the shared granth-tx: lock and deadlock this.
const tx = await Promise.race([
  B.evaluate(() => window.__stress.txAppend('B', 1)).then(() => 'completed', (e) => `rejected: ${String(e).slice(0, 70)}`),
  new Promise((r) => setTimeout(() => r('DEADLOCKED after 15s'), 15_000)),
]);
check('a transaction after failover still works', tx === 'completed', tx);

await browser.close();
await server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall two-tab failover checks passed');
process.exit(failures ? 1 : 0);
