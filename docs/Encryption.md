# Encrypting data at rest

Browser storage is not encrypted. OPFS, IndexedDB and localStorage all sit on
disk in plaintext, readable by anyone with access to the device profile. If you
cache someone's notes, messages, health records or client data locally, that is
worth fixing.

This page ships a working addon that does it. The full source is
[`examples/playground/demos/encrypted-fields.js`](https://github.com/sundarshahi/granth/blob/main/examples/playground/demos/encrypted-fields.js),
and its test asserts the plaintext is genuinely absent from storage rather than
taking the claim on trust.

## What this protects against, and what it does not

**It protects against:**

- device theft, or another user on the same machine
- disk forensics and backup extraction
- a sync process, support engineer or cloud backup handling the raw file

**It does not protect against XSS.** Script running on your origin calls your
decrypt path and gets plaintext, exactly as it would read localStorage. No
browser-side encryption changes that — the key has to be usable by your code, so
it is usable by anything running as your code.

**Do not use it for session tokens.** Those belong in an `httpOnly` cookie that
JavaScript cannot read at all — see
[Replacing web storage](/ReplacingWebStorage#where-auth-tokens-belong-read-this-first).

## Usage

```js
import { Granth } from 'granthdb';
import { encryptedFields, deriveKey } from './encrypted-fields.js';

const db = new Granth('notes', { worker: () => new Worker(/* … */) });
db.version(1).stores({ notes: '++id, title, folder, updated' });

// Derived from the user's passphrase, never stored. A per-user salt, kept with
// the account, means two users with the same passphrase get different keys.
const key = await deriveKey(passphrase, user.salt);

db.use(encryptedFields({ key, fields: ['body', 'attachments'] }));

await db.notes.add({
  title: 'Visible in the sidebar',   // plaintext: it is indexed and displayed
  folder: 'private',                 // plaintext: you filter on it
  body: 'Encrypted before it ever reaches SQLite',
});

const note = await db.notes.get(1);
note.body;    // decrypted transparently on read
```

## The rule that shapes the schema

**Encrypted fields cannot be indexed or queried.** Ciphertext does not sort or
compare, and a fresh IV per value means the same plaintext encrypts differently
every time — which is exactly what you want, and exactly why `where('body')`
cannot work.

So split the document deliberately:

| Keep plaintext | Encrypt |
|---|---|
| ids, foreign keys | free text, bodies, notes |
| titles you display in a list | attachments, blobs |
| fields you filter or sort on | anything a stranger should not read |
| timestamps used for ordering | PII beyond what you filter on |

If you must search encrypted content, search it **after** decryption on the
client, over a narrowed set:

```js
const candidates = await db.notes.where('folder').equals('private').toArray();
const hits = candidates.filter((n) => n.body.includes(term));  // already decrypted
```

## How it works

The addon uses the two `db.use()` hooks:

- **`before`** intercepts writes (`add`, `put`, `bulkAdd`, `bulkPut`, `update`,
  `upsert`) and replaces each named field with `{__enc: 1, iv, data}` before the
  call crosses into the Worker. The plaintext never reaches SQLite.
- **`after`** intercepts reads (`get`, `bulkGet`, `query`) and unseals anything
  carrying that envelope.

Crypto choices worth stating:

- **AES-GCM**, which is authenticated — tampering fails loudly instead of
  decrypting to garbage.
- **A fresh 12-byte IV per value.** Reusing an IV under the same key breaks GCM
  catastrophically; it is not a style preference.
- **PBKDF2, 310,000 iterations, SHA-256** for passphrase derivation, matching
  current OWASP guidance.
- **`extractable: false`** on the derived key, so it cannot be read back out of
  the CryptoKey.

## Verifying it actually encrypts

An encryption claim is worthless unless something checks the stored bytes. The
test reads the raw row underneath the addon:

```js
const stored = JSON.stringify(raw.prepare('SELECT "_doc" FROM "notes"').all());
assert.ok(!stored.includes(SECRET));       // plaintext absent
assert.ok(stored.includes('__enc'));       // envelope present
await assert.rejects(() => wrongKeyDb.notes.get(id));   // wrong key fails
```

Run it yourself:

```bash
node examples/playground/test-encryption.mjs
```

## Key management is the hard part

The addon is the easy half. Decide these before shipping:

- **Where does the key come from?** A user passphrase is honest but means a
  forgotten passphrase is unrecoverable data. A server-delivered key means the
  server can decrypt, so state that plainly in your privacy policy.
- **What happens on rotation?** Re-encrypting means reading and rewriting every
  row; do it in a transaction with a version marker on each document.
- **What happens on logout?** Drop the key and call `db.deleteDatabase()`. A key
  in memory survives a soft navigation.
- **Do you need recovery?** If yes, you need an escrow mechanism, and that is a
  design decision with real consequences — not a library feature.
