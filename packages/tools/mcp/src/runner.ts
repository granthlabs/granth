/**
 * Runs one snippet against a throwaway granthdb, inside a worker thread.
 *
 * A worker rather than the server's own thread, for one reason: a snippet that
 * loops can be TERMINATED. `Promise.race` against a timer cannot interrupt a
 * synchronous loop — the event loop is already blocked, so the timer never
 * fires — and a wedged server makes every later tool call hang with no
 * explanation. An assistant writing a seed loop gets that wrong occasionally,
 * which is exactly the traffic this server expects.
 *
 * It is a TERMINATION boundary, not a security one. A worker shares the process:
 * `node:fs` and `process` are still reachable from the snippet. Run this locally,
 * against code you asked it to run.
 *
 * The database is in-memory and thrown away after each call, so a snippet cannot
 * see the one before it. That is deliberate: an assistant probing the API should
 * get the same answer whatever it tried previously.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers, type Adapter } from 'granth-engine';
import { inlineRuntime } from 'granth-runtime-inline';
import { Granth } from 'granthdb';

interface RunInput {
  stores: Record<string, string>;
  code: string;
}

/**
 * SQLite returns BigInt for integers that do not fit a double, and rowids come
 * back that way; a Date survives granthdb's value codec. Neither is JSON, and
 * `JSON.stringify` throws on the first BigInt rather than degrading — so the
 * whole result would be lost to a formatting detail.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'undefined') return null;
  return value;
}

const { stores, code } = workerData as RunInput;

const sqlite = new DatabaseSync(':memory:');
const adapter: Adapter = {
  all: (sql, params = []) => sqlite.prepare(sql).all(...(params as never[])).map((r) => ({ ...r })),
  exec: (sql) => sqlite.exec(sql),
  run: (sql, params = []) => {
    const r = sqlite.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (name, fn) => sqlite.function(name, { deterministic: true }, fn as never),
};

const engine = createEngine(adapter);
const db = new Granth('granth-mcp-scratch', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});

// `AsyncFunction` is not a global. This is the documented way to reach it, and
// it is what makes `await` legal in the snippet body without wrapping the code
// in a string template the caller has to reason about.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

try {
  db.version(1).stores(stores);
  await db.open();
  const value = await new AsyncFunction('db', code)(db);
  // Stringified HERE, not in the parent: structured clone would choke on the
  // same values `replacer` exists to handle, and it would fail at the
  // postMessage rather than anywhere the caller can see.
  parentPort?.postMessage({ ok: true, json: JSON.stringify(value, replacer, 2) ?? 'undefined' });
} catch (err) {
  // The error IS the product for most calls: an assistant that reached for a
  // Dexie method granthdb does not implement learns more from the real
  // TypeError than from any wrapper around it. Name and message, unedited.
  const e = err as Error;
  parentPort?.postMessage({ ok: false, error: `${e.name ?? 'Error'}: ${e.message ?? String(err)}` });
} finally {
  await db.close().catch(() => {});
  sqlite.close();
}
