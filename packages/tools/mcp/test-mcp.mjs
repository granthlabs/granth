/**
 * End to end over the real protocol: spawn the server as a child process, speak
 * MCP to it over stdio, call the tools.
 *
 * Not by importing the handlers directly. The thing that breaks a stdio MCP
 * server is almost never the handler — it is a stray console.log corrupting the
 * JSON-RPC stream, a missing shebang, an unresolvable worker path in `dist`, or
 * a tool schema the client rejects. Every one of those survives a unit test of
 * the callback and fails the moment a real client connects.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEXIE_WAIVERS, DEXIE_DIVERGENCES } from 'granthdb';

const HERE = dirname(fileURLToPath(import.meta.url));

const client = new Client({ name: 'granth-mcp-test', version: '0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [join(HERE, 'dist/index.js')] })
);

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };

const text = (r) => r.content.map((c) => c.text).join('\n');
const run = (stores, code) => client.callTool({ name: 'granth_run', arguments: { stores, code } });

// ---- the tools are actually advertised
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ['granth_api', 'granth_run'], 'both tools listed');
n++;
ok('granth_run declares its inputs', tools.find((t) => t.name === 'granth_run')?.inputSchema?.properties?.code);

// ---- a real query, against real SQLite
const r1 = await run(
  { friends: '++id, name, age, *tags' },
  `await db.friends.bulkAdd([
     { name: 'Ada', age: 36, tags: ['math'] },
     { name: 'Bob', age: 12, tags: ['lego'] },
     { name: 'Cy',  age: 41, tags: ['math', 'chess'] },
   ]);
   return db.friends.where('age').above(18).orderBy('name').toArray();`
);
ok('a query round-trips', !r1.isError);
const rows = JSON.parse(text(r1));
assert.deepEqual(rows.map((r) => r.name), ['Ada', 'Cy'], 'filtered on one index, ordered by another');
n++;

// ---- multiEntry, because it is the thing most likely to be quietly wrong
const r2 = await run(
  { friends: '++id, name, *tags' },
  `await db.friends.bulkAdd([{ name: 'Ada', tags: ['math'] }, { name: 'Bob', tags: ['lego'] }]);
   return db.friends.where('tags').equals('math').toArray();`
);
ok('multiEntry works', JSON.parse(text(r2)).length === 1);

// ---- THE reason this server exists: a Dexie method granthdb does not implement
// must fail loudly, and the assistant must get the real error back.
const r3 = await run({ t: '++id, name' }, `return db.t.toCollection().clone();`);
ok('a waived Dexie method fails', r3.isError);
ok('and the real error comes back, not a wrapper', /clone is not a function/.test(text(r3)));

// ---- state does not leak between calls
const r4 = await run({ t: '++id, name' }, `return db.t.count();`);
ok('each call gets a fresh database', text(r4).trim() === '0');

// ---- a runaway snippet is TERMINATED, not merely raced.
// A synchronous loop never yields, so a promise timeout on the parent thread
// would sit here forever. This is the assertion the worker exists for.
const started = Date.now();
const r5 = await run({ t: '++id' }, `while (true) {}`);
ok('an infinite loop is killed', r5.isError && /Timeout/.test(text(r5)));
ok('and it is killed near the deadline, not on some later tick', Date.now() - started < 25_000);

// ---- the API surface is read off live objects
const r6 = await client.callTool({ name: 'granth_api', arguments: { className: 'Collection' } });
const api = JSON.parse(text(r6));
ok('Collection lists a method that exists', api.classes.Collection.methods.includes('sum'));
ok('and no internals', !api.classes.Collection.methods.some((m) => m.startsWith('_')));

const all = JSON.parse(text(await client.callTool({ name: 'granth_api', arguments: {} })));
ok('all four classes by default', Object.keys(all.classes).length === 4);

// ---- both lists, checked in OPPOSITE directions.
//
// The parity audit can only see members Dexie has and granth lacks, so a waiver
// for something granth actually ships is never looked up and never contradicted.
// `Dexie.use` sat there for a long time claiming "no equivalent" while use() was
// the addon hook, and nothing in the suite could say so. These two loops can.
const has = (key) => {
  const [cls, member] = key.split('.');
  const surface = all.classes[cls === 'Dexie' ? 'Granth' : cls];
  return surface ? surface.methods.includes(member) || surface.getters.includes(member) : null;
};

for (const key of Object.keys(DEXIE_WAIVERS)) {
  if (has(key) === null) continue;
  ok(`waived ${key} really is absent`, has(key) === false);
}
for (const key of Object.keys(DEXIE_DIVERGENCES)) {
  ok(`divergent ${key} really is present`, has(key) === true);
}

await client.close();
console.log(`granth-mcp: ${n} checks over the real protocol (queries run, waived methods fail, runaway snippets are killed)`);
