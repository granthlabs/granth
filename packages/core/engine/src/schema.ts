// Dexie-style schema strings -> SQLite DDL.
//
// Documents live as JSON in "_doc". Every declared index becomes a VIRTUAL
// generated column plus a real index, so SQLite does the actual index work.
// ponytail: no custom B-tree, no key encoding, no cursor machinery — that is
// the entire reason this library is small enough to trust.

/** keyPaths reach a JSON path and a column name, so they are a trust boundary. */
const KEYPATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export interface IndexDef {
  name: string;
  keyPaths: string[];
  unique: boolean;
  multi: boolean;
  compound: boolean;
  isPrimary?: boolean;
}

export interface StoreDef {
  table: string;
  primKey: { name: string; auto: boolean };
  indexes: IndexDef[];
}

export type StoresSpec = Record<string, string | null>;

function assertKeyPath(kp: string): string {
  if (!KEYPATH.test(kp)) throw new Error(`granth: invalid keyPath "${kp}"`);
  return kp;
}

const q = (id: string): string => {
  const str = String(id);
  // NUL terminates the C string SQLite actually parses, so an identifier
  // containing one is emitted whole and read TRUNCATED — `"a\0b"` arrives as
  // `"a`, an unterminated identifier. It fails safe (a syntax error, not an
  // injection) and keyPath validation rejects NUL long before this, but a
  // quoting function that can emit unparseable SQL is a broken last line of
  // defence. Refuse instead, loudly.
  if (str.includes('\u0000')) {
    throw new Error('granth: identifiers cannot contain a NUL character');
  }
  return `"${str.replace(/"/g, '""')}"`;
};
/** Column backing a keyPath. `address.city` -> ix$address$city */
export const col = (keyPath: string): string => `ix$${keyPath.replace(/\./g, '$')}`;
export const jsonPath = (keyPath: string): string => `$.${keyPath}`;

/**
 * Parse one Dexie store spec: '++id, name, &email, *tags, [first+last]'
 * The first entry is the primary key.
 */
export function parseStore(table: string, spec: string): StoreDef {
  const parts = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error(`granth: store "${table}" has no primary key`);

  const [pkSpec, ...idxSpecs] = parts;
  const auto = pkSpec.startsWith('++');
  // Check this before the keyPath regex — "cannot be multiEntry" is a far more
  // actionable error than "invalid keyPath" for the same typo.
  if (pkSpec.includes('*') || pkSpec.includes('['))
    throw new Error(`granth: primary key of "${table}" cannot be multiEntry or compound`);
  const pkName = assertKeyPath(pkSpec.replace(/^\+\+/, '').replace(/^&/, ''));

  const indexes: IndexDef[] = idxSpecs.map((raw): IndexDef => {
    let s = raw;
    const unique = s.startsWith('&');
    if (unique) s = s.slice(1);
    const multi = s.startsWith('*');
    if (multi) s = s.slice(1);

    if (s.startsWith('[')) {
      const keyPaths = s.replace(/^\[|\]$/g, '').split('+').map((k: string) => assertKeyPath(k.trim()));
      if (multi) throw new Error(`granth: compound index "${raw}" cannot be multiEntry`);
      return { name: `[${keyPaths.join('+')}]`, keyPaths, unique, multi: false, compound: true };
    }
    const kp = assertKeyPath(s);
    return { name: kp, keyPaths: [kp], unique, multi, compound: false };
  });

  // A DOTTED primary key is not supported: the key is a real SQLite column, and
  // reading it back out of a nested document would mean a different code path in
  // split/get/delete than the one every other key takes. Rejecting here is not
  // the interesting part — it already failed, but at first insert, with
  // `requires a "meta.uid"` on a document that HAS meta.uid. A wrong explanation
  // at the wrong moment costs more than the missing feature.
  if (pkName.includes('.')) {
    throw new Error(
      `granth: "${table}" declares a nested primary key "${pkName}", which is not supported. ` +
        `Use a top-level key and index the nested field instead: ` +
        `stores({ ${table}: '${pkName.split('.').pop()}, ${pkName}' }).`
    );
  }

  return { table, primKey: { name: pkName, auto }, indexes };
}

/** Every keyPath needing a generated column (compound members included, multiEntry excluded). */
function generatedPaths(store: StoreDef): string[] {
  const paths = new Set<string>();
  for (const ix of store.indexes) {
    if (ix.multi) continue; // multiEntry lives in a shadow table, not a column
    ix.keyPaths.forEach((kp) => paths.add(kp));
  }
  paths.delete(store.primKey.name); // the primary key is a real column already
  return [...paths];
}

export const shadowTable = (store: StoreDef, ix: IndexDef): string => `${store.table}$${ix.name}`;

/** DDL to create a store from nothing. */
export function createStoreSql(store: StoreDef): string[] {
  const t = store.table;
  const pk = store.primKey;
  const cols = [
    pk.auto ? `${q(pk.name)} INTEGER PRIMARY KEY AUTOINCREMENT` : `${q(pk.name)} PRIMARY KEY`,
    `"_doc" TEXT NOT NULL`,
    ...generatedPaths(store).map(
      (kp) => `${q(col(kp))} GENERATED ALWAYS AS (json_extract("_doc", '${jsonPath(kp)}')) VIRTUAL`
    ),
  ];
  const sql = [`CREATE TABLE IF NOT EXISTS ${q(t)} (${cols.join(', ')})`];
  for (const ix of store.indexes) sql.push(...createIndexSql(store, ix));
  return sql;
}

export function createIndexSql(store: StoreDef, ix: IndexDef): string[] {
  const t = store.table;
  if (ix.multi) {
    const s = shadowTable(store, ix);
    const pk = q(store.primKey.name);
    const fill = (row: string): string =>
      `INSERT OR IGNORE INTO ${q(s)}("v","k") SELECT je.value, ${row}.${pk} ` +
      `FROM json_each(${row}."_doc", '${jsonPath(ix.keyPaths[0] as string)}') je ` +
      // json_each on a scalar yields one row; only arrays are a multiEntry index.
      `WHERE json_type(${row}."_doc", '${jsonPath(ix.keyPaths[0] as string)}') = 'array'`;
    // Filling the shadow table stays in triggers: an INSERT..SELECT json_each()
    // has no WHERE to plan, so it costs what it should.
    //
    // Emptying it does NOT. SQLite will not use an index for the WHERE clause of
    // a DELETE inside a trigger body — it rewinds and scans the whole table, and
    // it rejects INDEXED BY there for the same reason: no index is being chosen.
    // As `AFTER DELETE ... DELETE FROM shadow WHERE k = old.id` that cost a full
    // scan of the shadow table for EVERY row written. Measured: clearing 100,000
    // rows took 168 SECONDS, against 332 ms for the same table with the
    // multiEntry index removed. Purging is done set-based in the engine's write
    // paths instead, where the planner does use the index. See purgeShadows().
    return [
      `CREATE TABLE IF NOT EXISTS ${q(s)} ("v", "k", PRIMARY KEY("v","k"))`,
      `CREATE INDEX IF NOT EXISTS ${q(s + '$k')} ON ${q(s)}("k")`,
      `CREATE TRIGGER IF NOT EXISTS ${q(s + '$ai')} AFTER INSERT ON ${q(t)} BEGIN ${fill('new')}; END`,
      `CREATE TRIGGER IF NOT EXISTS ${q(s + '$au')} AFTER UPDATE ON ${q(t)} BEGIN ${fill('new')}; END`,
    ];
  }
  const target = ix.keyPaths.map((kp) => q(kp === store.primKey.name ? kp : col(kp))).join(', ');
  return [
    `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(`${t}$${ix.name}`)} ON ${q(t)} (${target})`,
  ];
}

export function dropStoreSql(store: StoreDef): string[] {
  const sql = [];
  for (const ix of store.indexes.filter((i) => i.multi)) {
    const s = shadowTable(store, ix);
    sql.push(
      `DROP TRIGGER IF EXISTS ${q(s + '$ai')}`,
      `DROP TRIGGER IF EXISTS ${q(s + '$ad')}`,
      `DROP TRIGGER IF EXISTS ${q(s + '$au')}`,
      `DROP TABLE IF EXISTS ${q(s)}`
    );
  }
  sql.push(`DROP TABLE IF EXISTS ${q(store.table)}`);
  return sql;
}

/** Parse a whole `.stores({...})` map. */
export function parseSchema(stores: StoresSpec): Record<string, StoreDef> {
  return Object.fromEntries(
    Object.entries(stores)
      .filter((e): e is [string, string] => e[1] !== null) // Dexie: null deletes a store
      .map(([table, spec]) => [table, parseStore(table, spec)])
  );
}

/** Table names deleted in this version (spec === null). */
export const deletedStores = (stores: StoresSpec): string[] =>
  Object.entries(stores).filter(([, s]) => s === null).map(([t]) => t);

export function findIndex(store: StoreDef, name: string): IndexDef {
  if (name === store.primKey.name) {
    return { name, keyPaths: [name], unique: true, multi: false, compound: false, isPrimary: true };
  }
  const ix = store.indexes.find((i) => i.name === name);
  if (!ix) {
    throw new Error(
      `granth: "${name}" is not an index on "${store.table}". ` +
        `Declared: ${[store.primKey.name, ...store.indexes.map((i) => i.name)].join(', ')}`
    );
  }
  return ix;
}

/** SQL expression addressing an index, for WHERE/ORDER BY. */
export function indexExpr(store: StoreDef, ix: IndexDef, kpIndex = 0): string {
  const kp = ix.keyPaths[kpIndex] as string;
  return q(kp === store.primKey.name ? kp : col(kp));
}

export { q as quoteIdent };
