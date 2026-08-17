/**
 * Is OPFS "unreadable from outside the browser"? Measure it, don't assume it.
 *
 * Writes a distinctive string through granthdb into the OPFS backend, closes the
 * browser, and then greps the browser profile directory FROM NODE — an ordinary
 * process with no browser involvement at all.
 *
 * If the string turns up, "origin-private" means other ORIGINS cannot read it.
 * It does not mean the disk cannot.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const CANARY = 'CANARY-a7f3e9-medical-record-patient-diagnosis';

const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/stress.html`;

// A PERSISTENT profile: the default launch() uses a throwaway dir that is deleted
// on close, which would hide exactly what we are testing.
const profile = mkdtempSync(join(tmpdir(), 'opfs-probe-'));
const ctx = await chromium.launchPersistentContext(profile, { headless: true });
const page = await ctx.newPage();
await page.goto(base);
await page.waitForFunction(() => window.__stress !== undefined, null, { timeout: 60_000 });

const kind = await page.evaluate(() => window.__stress.open());
await page.evaluate((secret) => window.__stress.writeSecret(secret), CANARY);
await page.evaluate(() => window.__stress.flush?.());
await ctx.close();                        // browser gone; only the disk remains
await server.close();

/** Walk the profile looking for the canary in raw bytes. */
function hunt(dir, hits = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return hits; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) hunt(full, hits);
    else if (st.size < 64 * 1024 * 1024) {
      try {
        if (readFileSync(full).includes(CANARY)) hits.push({ file: full, bytes: st.size });
      } catch { /* unreadable, skip */ }
    }
  }
  return hits;
}

const hits = hunt(profile);

console.log(`storage backend used: ${kind}`);
console.log(`profile searched:     ${profile}`);
console.log(`\nfiles containing the plaintext canary: ${hits.length}`);
for (const h of hits) console.log(`  ${h.file.replace(profile, '<profile>')}  (${h.bytes} bytes)`);

console.log(
  hits.length
    ? '\nRESULT: OPFS data is readable from disk by an ordinary process.\n' +
      '        "Origin-private" is isolation between ORIGINS, not encryption.'
    : '\nRESULT: canary not found on disk in this profile.'
);

rmSync(profile, { recursive: true, force: true });
process.exit(0);
