/**
 * Field-level encryption as an addon — AES-GCM via Web Crypto.
 *
 * WHAT THIS IS FOR: user data at rest. A local database is readable by anyone
 * with access to the device profile — OPFS is not encrypted, and neither is
 * localStorage or IndexedDB. If you cache someone's notes, messages or health
 * data locally, encrypting the sensitive fields means a stolen laptop or a
 * forensic tool does not hand over plaintext.
 *
 * WHAT THIS IS NOT FOR: defending against XSS, and NOT for session tokens.
 * Script running on your origin can call db and get plaintext back, exactly as
 * it can read localStorage. A session token belongs in an httpOnly; Secure;
 * SameSite cookie that JavaScript cannot reach at all. Encrypting a token in
 * browser storage moves the problem, it does not solve it.
 *
 * The honest threat model this DOES cover:
 *   - device theft / another user on the same machine
 *   - disk forensics and backup extraction
 *   - a support engineer or sync process handling the raw file
 *
 * Encrypted fields cannot be indexed or queried: ciphertext does not sort or
 * compare. Keep the fields you filter on in plaintext and encrypt the payload.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Derive a non-extractable AES-GCM key from a passphrase. */
export async function deriveKey(passphrase, salt, iterations = 310_000) {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,                      // NOT extractable: the key cannot be read back out
    ['encrypt', 'decrypt']
  );
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encryptValue(key, value) {
  // A fresh IV per value. Reusing an IV with the same key breaks GCM
  // catastrophically — it is not a "should", it leaks the plaintext.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = enc.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { __enc: 1, iv: b64(iv), data: b64(cipher) };
}

async function decryptValue(key, box) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(box.iv) },
    key,
    unb64(box.data)
  );
  return JSON.parse(dec.decode(plain));
}

const isBox = (v) => v !== null && typeof v === 'object' && v.__enc === 1;

const WRITES = new Set(['add', 'put', 'bulkAdd', 'bulkPut', 'update', 'upsert']);
const READS = new Set(['get', 'bulkGet', 'query']);

/**
 * @param key    a CryptoKey from deriveKey()
 * @param fields field names to encrypt, e.g. ['body', 'notes']
 */
export function encryptedFields({ key, fields }) {
  const secret = new Set(fields);

  const seal = async (doc) => {
    if (!doc || typeof doc !== 'object') return doc;
    const out = { ...doc };
    for (const f of secret) {
      if (f in out && out[f] !== undefined && !isBox(out[f])) out[f] = await encryptValue(key, out[f]);
    }
    return out;
  };

  const open = async (doc) => {
    if (!doc || typeof doc !== 'object') return doc;
    const out = { ...doc };
    for (const f of secret) if (isBox(out[f])) out[f] = await decryptValue(key, out[f]);
    return out;
  };

  return {
    name: 'encrypted-fields',
    setup(ctx) {
      ctx.before(async (call) => {
        if (!WRITES.has(call.op)) return undefined;
        const args = call.args;
        // add/put take a doc; bulk* take an array; update/upsert take (key, changes).
        if (call.op === 'update' || call.op === 'upsert') args[2] = await seal(args[2]);
        else if (Array.isArray(args[1])) args[1] = await Promise.all(args[1].map(seal));
        else args[1] = await seal(args[1]);
        return undefined;                 // never short-circuit: the write must happen
      });

      ctx.after(async (call, result) => {
        if (!READS.has(call.op) || result == null) return undefined;
        if (Array.isArray(result)) return Promise.all(result.map(open));
        return open(result);
      });
    },
  };
}

/**
 * Re-encrypt every sealed field under a NEW key.
 *
 * Key rotation is the part people postpone until they need it urgently, which
 * is the worst time to design it. The shape that works:
 *
 *  - decrypt with the OLD key and re-encrypt with the NEW one, row by row;
 *  - inside ONE transaction, so a crash halfway leaves the table entirely on the
 *    old key rather than half-and-half — a half-rotated table is readable by
 *    neither key and is the genuinely unrecoverable state;
 *  - the caller swaps the addon over afterwards.
 *
 * IMPORTANT: `db` must NOT have the encryption addon registered. Rotation works
 * on the sealed envelopes, and an addon in the way would decrypt them on read
 * and re-seal them under whichever key IT holds — silently doing nothing, or
 * worse, writing plaintext. Dispose the addon, rotate, then re-register with the
 * new key:
 *
 *     await handle.dispose();
 *     await rotateKey(db, 'notes', ['body'], oldKey, newKey);
 *     handle = db.use(encryptedFields({ key: newKey, fields: ['body'] }));
 *
 * Returns the number of rows rewritten.
 */
export async function rotateKey(db, table, fields, oldKey, newKey) {
  if (db.plugins.includes('encrypted-fields')) {
    throw new Error(
      'rotateKey: dispose the encrypted-fields addon first — it would decrypt on ' +
      'read and re-seal under its own key, so the rotation would silently do nothing.'
    );
  }

  const secret = new Set(fields);
  const rows = await db.table(table).toArray();
  const rewritten = [];

  for (const row of rows) {
    const out = { ...row };
    for (const f of secret) {
      if (!isBox(out[f])) continue;               // never sealed, or already rotated
      const plain = await decryptValue(oldKey, out[f]);
      out[f] = await encryptValue(newKey, plain);
    }
    rewritten.push(out);
  }

  // One transaction: every row moves to the new key, or none does.
  await db.transaction('rw', [db.table(table)], async () => {
    for (const row of rewritten) await db.table(table).put(row);
  });

  return rewritten.length;
}
