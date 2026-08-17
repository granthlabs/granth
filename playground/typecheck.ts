import { Granth, Table, VersionError, NoLeaderError } from 'granth';
import { staleWhileRevalidate } from 'opfs-leader';

interface Friend { id?: number; name: string; age: number; tags?: string[] }

class MyDB extends Granth {
  friends!: Table<Friend, number>;
  constructor() {
    super('myapp', { worker: () => new Worker('/db.worker.js', { type: 'module' }) });
    this.friends = this.table<Friend, number>('friends');
    this.version(1).stores({ friends: '++id, name, age, *tags' });
  }
}

async function main() {
  const db = new MyDB();
  await db.open();
  const id: number = await db.friends.add({ name: 'ada', age: 36 });
  const one: Friend | undefined = await db.friends.get(id);
  const many: Friend[] = await db.friends.where('age').above(30).toArray();
  const tuple: Friend[] = await db.friends.where('[name+age]').equals(['ada', 36]).toArray();
  const some: Array<Friend | undefined> = await db.friends.bulkGet([1, 2]);
  const n: number = await db.friends.where('name').startsWith('a').count();
  await db.friends.where('age').below(18).modify({ junior: true });
  await db.transaction((tx) => { tx.friends.add({ name: 'bob', age: 2 } as any); });
  const sub = db.liveQuery(() => db.friends.toArray()).subscribe((rows: Friend[]) => rows.length);
  sub.unsubscribe();
  await staleWhileRevalidate(() => db.friends.toArray(), async () => [] as Friend[]);
  console.log(id, one, many, tuple, some, n, VersionError, NoLeaderError);
}
main();

// --- Dexie-compatible surface must typecheck too ---------------------------
import { importFromIndexedDB, suggestSchema } from 'granth/migrate-idb';

async function compat(db: MyDB) {
  const arr: Friend[] = await db.friends.where('age').above(1).sortBy('name'); // ARRAY, not Collection
  const idxKeys = await db.friends.orderBy('age').keys();
  const uniq = await db.friends.orderBy('age').uniqueKeys();
  const fk = await db.friends.orderBy('age').firstKey();
  await db.friends.orderBy('age').desc().until((f) => f.age > 5).eachKey((k) => k);
  await db.friends.toCollection().distinct().modify(function (f, ctx) { ctx.value = undefined; });
  await db.friends.upsert(1, { name: 'x' });
  await db.friends.bulkUpdate([{ key: 1, changes: { name: 'y' } }]);
  db.friends.hook('creating', (pk: number, obj: Friend) => { obj.name = obj.name.trim(); });
  db.friends.mapToClass(class {});
  const kind = await db.storageKind();
  await db.transaction('rw', db.friends, async () => { await db.friends.count(); });
  await importFromIndexedDB(db, { from: 'old-app' });
  const schema: Record<string, string> = await suggestSchema('old-app');
  console.log(arr, idxKeys, uniq, fk, kind, schema, db.verno, db.isOpen());
}
console.log(compat);
