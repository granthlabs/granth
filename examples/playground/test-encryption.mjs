/**
 * Proves the encryption addon actually encrypts.
 *
 * The claim "your data is encrypted at rest" is worthless unless something reads
 * the RAW stored bytes back and confirms the plaintext is absent. That is what
 * this does: it queries the engine directly, underneath the addon, and asserts
 * the secret string does not appear anywhere in the stored document.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Granth } from 'granthdb';
import { inlineRuntime } from 'granth-runtime-inline';
import { createEngine, rpcHandlers } from 'granth-engine';
import { encryptedFields, deriveKey, rotateKey } from './demos/encrypted-fields.js';

const adapter = (db) => ({
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
});

const raw = new DatabaseSync(':memory:');
const engine = createEngine(adapter(raw));
const db = new Granth('enc', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
db.version(1).stores({ notes: '++id, title, folder' });
await db.open();

const key = await deriveKey('correct horse battery staple', 'per-user-salt');
db.use(encryptedFields({ key, fields: ['body', 'tags'] }));

const SECRET = 'my bank password is hunter2';
const id = await db.notes.add({ title: 'Visible title', folder: 'private', body: SECRET, tags: ['a'] });

// 1. round-trip through the addon
const back = await db.notes.get(id);
assert.equal(back.body, SECRET, 'decrypts on read');
assert.deepEqual(back.tags, ['a'], 'non-string values round-trip too');
assert.equal(back.title, 'Visible title', 'unencrypted fields are untouched');

// 2. THE test: the raw stored row must not contain the plaintext
const stored = JSON.stringify(raw.prepare('SELECT "_doc" FROM "notes"').all());
assert.ok(!stored.includes(SECRET), `plaintext found in storage: ${stored.slice(0, 200)}`);
assert.ok(!stored.includes('hunter2'), 'plaintext fragment found in storage');
assert.ok(stored.includes('__enc'), 'expected the ciphertext envelope in storage');
assert.ok(stored.includes('Visible title'), 'unencrypted fields should stay readable');

// 3. queries on PLAINTEXT indexes still work (this is why you leave them plaintext)
const inFolder = await db.notes.where('folder').equals('private').toArray();
assert.equal(inFolder.length, 1);
assert.equal(inFolder[0].body, SECRET, 'collection reads decrypt too');

// 4. a different key must NOT decrypt
const wrong = await deriveKey('wrong passphrase', 'per-user-salt');
const db2 = new Granth('enc2', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
db2.version(1).stores({ notes: '++id, title, folder' });
await db2.open();
db2.use(encryptedFields({ key: wrong, fields: ['body', 'tags'] }));
await assert.rejects(() => db2.notes.get(id), 'the wrong key must fail, not return garbage');

// 5. every write path seals, not just add()
await db.notes.put({ id: 2, title: 't2', folder: 'private', body: SECRET });
await db.notes.update(2, { body: 'updated secret' });
const all = JSON.stringify(raw.prepare('SELECT "_doc" FROM "notes"').all());
assert.ok(!all.includes(SECRET), 'put() must seal');
assert.ok(!all.includes('updated secret'), 'update() must seal');
assert.equal((await db.notes.get(2)).body, 'updated secret');

// --- 6. key rotation --------------------------------------------------------
{
  const rotDb = new Granth('rot', {
    runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
  });
  rotDb.version(1).stores({ notes: '++id, title, folder' });
  await rotDb.open();

  const k1 = await deriveKey('first passphrase', 'salt-1');
  const k2 = await deriveKey('second passphrase', 'salt-1');

  let handle = rotDb.use(encryptedFields({ key: k1, fields: ['body'] }));
  await rotDb.notes.clear();
  // Capture the ids: clear() does not reset auto-increment, so assuming id 1
  // silently tests nothing — get() would return undefined and never decrypt.
  const idA = await rotDb.notes.add({ title: 'r1', folder: 'f', body: 'rotate me' });
  await rotDb.notes.add({ title: 'r2', folder: 'f', body: 'me too' });

  // Rotating with the addon still attached must REFUSE rather than silently
  // no-op — a rotation that reports success and changed nothing is the worst
  // possible outcome, because you then discard the old key.
  await assert.rejects(
    () => rotateKey(rotDb, 'notes', ['body'], k1, k2),
    /dispose the encrypted-fields addon first/,
    'rotation must refuse while the addon is attached'
  );

  await handle.dispose();
  const n = await rotateKey(rotDb, 'notes', ['body'], k1, k2);
  assert.equal(n, 2, 'both rows should be rewritten');

  // The OLD key must no longer open it...
  handle = rotDb.use(encryptedFields({ key: k1, fields: ['body'] }));
  await assert.rejects(() => rotDb.notes.get(idA), 'the old key must stop working');
  await handle.dispose();

  // ...and the NEW key must.
  handle = rotDb.use(encryptedFields({ key: k2, fields: ['body'] }));
  const back = await rotDb.notes.toArray();
  assert.deepEqual(back.map((r) => r.body).sort(), ['me too', 'rotate me']);

  // Still ciphertext on disk after rotation.
  const afterRot = JSON.stringify(raw.prepare('SELECT "_doc" FROM "notes"').all());
  assert.ok(!afterRot.includes('rotate me'), 'plaintext must not appear after rotation');
  await handle.dispose();
  console.log('key rotation: verified (refuses while attached, old key dead, new key works)');
}

console.log('encryption addon: all assertions passed (plaintext absent from storage)');
process.exit(0);
