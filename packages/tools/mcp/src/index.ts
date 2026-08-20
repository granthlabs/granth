#!/usr/bin/env node
/**
 * An MCP server for granthdb.
 *
 * WHY THIS EXISTS, given the docs are already published as llms.txt and
 * llms-full.txt: a model with a fetch tool can read every page in one request,
 * so a server that only serves documentation would add an install step and give
 * nothing back. What a fetch cannot do is RUN the code.
 *
 * The failure this addresses is specific. granthdb is Dexie-compatible, so an
 * assistant writes granthdb by pattern-matching Dexie — and eight Dexie members
 * are deliberately not implemented, with one more that shares a name and not a
 * contract. Documentation does not stop that; the code running and failing does.
 * Two tools, therefore:
 *
 *   granth_run  — execute a snippet against a real, throwaway database
 *   granth_api  — the surface that actually exists, by reflection, plus both
 *                 lists: what is absent, and what means something else here
 *
 * `granth_api` is a listing question and `granth_run` is a probing one. Without
 * the first, an assistant discovers the API by guessing forty times.
 */
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Granth, DEXIE_WAIVERS, DEXIE_DIVERGENCES } from 'granthdb';

const RUNNER = fileURLToPath(new URL('./runner.js', import.meta.url));

/** Long enough for a seed loop of a few thousand rows; short enough to notice. */
const TIMEOUT_MS = 15_000;

interface RunResult {
  ok: boolean;
  json?: string;
  error?: string;
}

/**
 * Run a snippet in a worker, and kill it if it overruns.
 *
 * `terminate()` rather than a rejected promise: the point of the worker is that
 * a snippet which never yields can still be stopped, and a race the main thread
 * loses does not stop anything.
 */
function runInWorker(stores: Record<string, string>, code: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = new Worker(RUNNER, { workerData: { stores, code } });
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `Timeout: the snippet did not finish within ${TIMEOUT_MS / 1000}s and was terminated.` }),
      TIMEOUT_MS
    );
    worker.on('message', (m: RunResult) => done(m));
    worker.on('error', (e: Error) => done({ ok: false, error: `${e.name}: ${e.message}` }));
    // A worker that exits without posting anything has crashed in a way the
    // error handler did not see — process.exit() inside the snippet, or an OOM.
    // Resolving here stops the tool call hanging until the timeout instead.
    worker.on('exit', () => done({ ok: false, error: 'The worker exited without returning a result.' }));
  });
}

/**
 * Every callable name on an object, walking the prototype chain the way a caller
 * reaches them. Underscore-prefixed members are internal and excluded — they are
 * the ones most likely to look inviting and break next release.
 */
function surfaceOf(o: object): { methods: string[]; getters: string[] } {
  const methods = new Set<string>();
  const getters = new Set<string>();
  for (let p: object | null = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d?.get) getters.add(name);
      else if (typeof (d?.value) === 'function') methods.add(name);
    }
  }
  return { methods: [...methods].sort(), getters: [...getters].sort() };
}

/**
 * A database that is never opened, purely to reflect over.
 *
 * `locks` is stubbed so it never elects a leader, and the worker factory throws
 * because nothing should ever reach it: this instance answers "what methods
 * exist", which is a question about prototypes, not about data.
 */
function probe() {
  const db = new Granth('granth-mcp-probe', {
    worker: () => { throw new Error('granth-mcp: the probe database is shape-only and never opens'); },
    locks: { request() {} },
  });
  db.version(1).stores({ t: '++id, name, age, *tags, [name+age]' });
  const table = db.table('t');
  return { db, table, collection: table.toCollection(), where: table.where('name') };
}

const server = new McpServer({ name: 'granth-mcp', version: '0.2.11' });

server.registerTool(
  'granth_run',
  {
    title: 'Run granthdb code',
    description:
      'Execute a snippet against a real, throwaway granthdb backed by in-memory SQLite, and return what it produced. ' +
      'Use this to CHECK granthdb code before suggesting it — the API is Dexie-compatible but not identical, so a method ' +
      'that exists in Dexie may not exist here. The database is empty and discarded after every call, so seed what you need ' +
      'inside the snippet.',
    inputSchema: {
      stores: z
        .record(z.string())
        .describe(
          'The schema, exactly as passed to db.version(1).stores() — e.g. { "friends": "++id, name, age, *tags, [name+age]" }. ' +
            'First entry is the primary key; ++ auto-increments, & is unique, * is multiEntry, [a+b] is compound.'
        ),
      code: z
        .string()
        .describe(
          'An async function body with `db` in scope. Use `return` to see a value. ' +
            'e.g. await db.friends.bulkAdd([{name:"Ada",age:36}]); return db.friends.where("age").above(18).toArray();'
        ),
    },
  },
  async ({ stores, code }) => {
    const r = await runInWorker(stores, code);
    return {
      content: [{ type: 'text' as const, text: r.ok ? (r.json ?? 'undefined') : (r.error ?? 'Unknown error') }],
      // The error is the useful half of this tool as often as the value is, so
      // it comes back as readable content rather than a protocol-level failure.
      isError: !r.ok,
    };
  }
);

server.registerTool(
  'granth_api',
  {
    title: 'granthdb API surface',
    description:
      'The methods that actually exist on Granth, Table, Collection and WhereClause, read off the live objects rather than ' +
      'from documentation, plus the Dexie members granthdb deliberately does not implement, and the ones that share a Dexie ' +
      'name but not its contract. Use this before writing granthdb code from Dexie knowledge.',
    inputSchema: {
      className: z
        .enum(['Granth', 'Table', 'Collection', 'WhereClause', 'all'])
        .optional()
        .describe('Which class to describe. Defaults to all of them.'),
    },
  },
  async ({ className }) => {
    const { db, table, collection, where } = probe();
    try {
      const all = {
        Granth: surfaceOf(db),
        Table: surfaceOf(table),
        Collection: surfaceOf(collection),
        WhereClause: surfaceOf(where),
      };
      const wanted =
        !className || className === 'all' ? all : { [className]: all[className] };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                classes: wanted,
                notImplemented: DEXIE_WAIVERS,
                sameNameDifferentContract: DEXIE_DIVERGENCES,
                note:
                  'Anything absent from `classes` and absent from `notImplemented` is a bug, not a decision — ' +
                  'the parity audit in CI fails on an un-waived gap against the real dexie package.',
                docs: 'https://granthlabs.github.io/llms-full.txt',
              },
              null,
              2
            ),
          },
        ],
      };
    } finally {
      // A Granth instance holds a BroadcastChannel, which keeps the event loop
      // alive. The probe never opened, but it did construct.
      db.close();
    }
  }
);

await server.connect(new StdioServerTransport());
