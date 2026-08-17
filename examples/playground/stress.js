/**
 * A tab in the multi-tab stress test. It does nothing on its own; the driver
 * (concurrency-test.mjs) calls into `window.__stress` from Playwright.
 *
 * The point is the topology: every tab opens the SAME database, so exactly one
 * of them holds the OPFS connection and the rest are RPC clients over
 * BroadcastChannel. Killing the leader mid-write is what we are actually testing.
 */

import { Granth } from 'granthdb';

const db = new Granth('stress', {
  worker: () => new Worker(new URL('./stress.worker.js', import.meta.url), { type: 'module' }),
});
db.version(1).stores({ rows: 'id, tab, n' });

const status = (t) => { document.getElementById('status').textContent = t; };

window.__stress = {
  async open() {
    await db.open();
    return db.storageKind();
  },

  /**
   * Write `count` rows with deterministic ids, one at a time so a kill can land
   * mid-sequence. Returns the ids this tab believes it durably wrote.
   *
   * Each write is awaited and recorded ONLY after it resolves, so the driver can
   * compare "claimed written" against "actually in the database" — that gap is
   * where a lost or double-applied write shows up.
   */
  async write(tab, count, delayMs = 0) {
    const ok = [];
    for (let n = 0; n < count; n++) {
      const id = `${tab}-${n}`;
      try {
        await db.rows.put({ id, tab, n });
        ok.push(id);
        status(`${tab}: ${ok.length}/${count}`);
      } catch (err) {
        // A failed write is fine and expected during failover; a SILENT loss is
        // not. Record it so the driver can tell the two apart.
        return { ok, failedAt: id, error: String(err?.message ?? err) };
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    return { ok, failedAt: null, error: null };
  },

  async count() { return db.rows.count(); },
  async all() { return (await db.rows.toArray()).map((r) => r.id); },
  async wipe() { await db.rows.clear(); return db.rows.count(); },

  /** Interactive transaction: used to prove isolation across tabs. */
  async txAppend(tab, n) {
    await db.transaction('rw', ['rows'], async (tx) => {
      const before = await tx.rows.count();
      await new Promise((r) => setTimeout(r, 30)); // widen the window on purpose
      await tx.rows.put({ id: `tx-${tab}-${n}`, tab, n: before });
    });
    return true;
  },
};

status('ready');
