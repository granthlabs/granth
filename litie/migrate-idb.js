// Migrate an existing IndexedDB (Dexie-created or plain) database into litie.
//
// Runs on the MAIN THREAD, because that is where the old IndexedDB lives. It
// reads with plain IDB APIs, so it works whether or not Dexie is still installed.

/**
 * Inspect an existing IndexedDB database without importing anything.
 * @returns {Promise<{name: string, version: number, stores: Array<{name: string, keyPath: any, autoIncrement: boolean, indexes: Array, count: number}>}>}
 */
export function inspectIndexedDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      // opening with no version created it — it did not exist
      req.transaction.abort();
      reject(new Error(`litie: no IndexedDB database named "${dbName}"`));
    };
    req.onsuccess = async () => {
      const idb = req.result;
      try {
        const names = [...idb.objectStoreNames].filter((n) => !n.startsWith('_')); // skip Dexie internals
        if (!names.length) return resolve({ name: dbName, version: idb.version, stores: [] });
        const t = idb.transaction(names, 'readonly');
        const stores = await Promise.all(
          names.map(
            (name) =>
              new Promise((res, rej) => {
                const os = t.objectStore(name);
                const c = os.count();
                c.onsuccess = () =>
                  res({
                    name,
                    keyPath: os.keyPath,
                    autoIncrement: os.autoIncrement,
                    indexes: [...os.indexNames].map((i) => {
                      const ix = os.index(i);
                      return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
                    }),
                    count: c.result,
                  });
                c.onerror = () => rej(c.error);
              })
          )
        );
        resolve({ name: dbName, version: idb.version, stores });
      } catch (err) {
        reject(err);
      } finally {
        idb.close();
      }
    };
  });
}

/** Derive a litie `stores({...})` schema string from an existing IndexedDB store. */
export function schemaFromStore(store) {
  const pk = Array.isArray(store.keyPath)
    ? `[${store.keyPath.join('+')}]`
    : store.keyPath ?? '';
  if (!pk) {
    throw new Error(
      `litie: store "${store.name}" uses out-of-line keys, which litie does not support. ` +
        `Give it an inline keyPath, or import it manually with an added key field.`
    );
  }
  const parts = [(store.autoIncrement ? '++' : '') + pk];
  for (const ix of store.indexes) {
    const kp = Array.isArray(ix.keyPath) ? `[${ix.keyPath.join('+')}]` : ix.keyPath;
    if (!kp || kp === pk) continue;
    parts.push((ix.unique ? '&' : '') + (ix.multiEntry ? '*' : '') + kp);
  }
  return parts.join(', ');
}

/** Read every record of one object store. */
function readAll(dbName, storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const idb = req.result;
      const t = idb.transaction(storeName, 'readonly');
      const g = t.objectStore(storeName).getAll();
      g.onsuccess = () => { resolve(g.result); idb.close(); };
      g.onerror = () => { reject(g.error); idb.close(); };
    };
  });
}

/**
 * Copy every record from an existing IndexedDB database into an open Litie.
 *
 * Idempotent by construction: it uses `bulkPut`, so re-running overwrites rather
 * than duplicating. It does NOT delete the source — verify, then delete yourself.
 *
 * @param {import('./index.js').Litie} db  an OPEN Litie
 * @param {object} opts
 * @param {string} opts.from        name of the IndexedDB database to read
 * @param {string[]} [opts.stores]  which stores to copy. Default: those that exist in both
 * @param {number} [opts.chunkSize] rows per batch. Default 1000
 * @param {(p: {store: string, done: number, total: number}) => void} [opts.onProgress]
 * @returns {Promise<Record<string, number>>} rows imported per store
 */
export async function importFromIndexedDB(db, { from, stores, chunkSize = 1000, onProgress } = {}) {
  const info = await inspectIndexedDB(from);
  const target = new Set(db.tables.map((t) => t.name));
  const chosen = (stores ?? info.stores.map((s) => s.name)).filter((n) => target.has(n));

  const skipped = (stores ?? info.stores.map((s) => s.name)).filter((n) => !target.has(n));
  if (skipped.length) {
    // Loud, because silently importing half a database is worse than failing.
    // eslint-disable-next-line no-console
    console.warn(`litie: skipping ${skipped.join(', ')} — no matching table declared in stores()`);
  }

  const imported = {};
  for (const name of chosen) {
    const rows = await readAll(from, name);
    const table = db.table(name);
    for (let i = 0; i < rows.length; i += chunkSize) {
      await table.bulkPut(rows.slice(i, i + chunkSize));
      onProgress?.({ store: name, done: Math.min(i + chunkSize, rows.length), total: rows.length });
    }
    imported[name] = rows.length;
  }
  await db.flush?.().catch(() => {});
  return imported;
}

/**
 * Print the `stores({...})` object matching an existing IndexedDB database, so a
 * migration starts from the real schema instead of a guess.
 */
export async function suggestSchema(dbName) {
  const info = await inspectIndexedDB(dbName);
  return Object.fromEntries(info.stores.map((s) => [s.name, schemaFromStore(s)]));
}
