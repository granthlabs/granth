import { DatabaseSync } from 'node:sqlite';
import { createEngine } from 'granth-engine';
const A = (db)=>({all:(s,p=[])=>db.prepare(s).all(...p).map(r=>({...r})),exec:s=>db.exec(s),
  run:(s,p=[])=>{const r=db.prepare(s).run(...p);return{changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)}}});
const e = createEngine(A(new DatabaseSync(':memory:')));
e.migrate([{version:1,stores:{t:'++id, when, flag, big, txt, score'}}]);
const bad = [];
const check = (name, fn) => { try { const r = fn(); if (r) bad.push(`${name}: ${r}`); } catch (err) { bad.push(`${name}: THREW ${err.message.slice(0,90)}`); } };

// 1. Date — Dexie (structured clone) preserves Date objects. JSON does not.
check('Date round-trip', () => {
  const d = new Date('2020-01-02T03:04:05.678Z');
  const id = e.add('t', { when: d });
  const got = e.get('t', id).when;
  return got instanceof Date ? null : `Date came back as ${typeof got} (${JSON.stringify(got)})`;
});
// 2. boolean in an index
check('boolean value + index query', () => {
  const id = e.add('t', { flag: true });
  const got = e.get('t', id).flag;
  if (got !== true) return `boolean came back as ${JSON.stringify(got)}`;
  const hit = e.query('t', {or:[{and:[{index:'flag',op:'equals',values:[true]}]}]}, 'count');
  return hit === 1 ? null : `where(flag).equals(true) matched ${hit}, expected 1`;
});
// 3. update() setting a field to null
check('update to null', () => {
  const id = e.add('t', { txt: 'x', score: 5 });
  e.update('t', id, { score: null });
  const got = e.get('t', id);
  return 'score' in got ? null : `score was DELETED, not set to null (json_patch merge semantics)`;
});
// 4. big integers
check('int > MAX_SAFE_INTEGER', () => {
  const id = e.add('t', { big: 9007199254740993 });
  const got = e.get('t', id).big;
  return got === 9007199254740993 ? null : `got ${got}`;
});
// 5. ￿ inside a startsWith prefix range
check('U+FFFF in indexed string', () => {
  e.add('t', { txt: 'a￿ZZ' });
  e.add('t', { txt: 'ab' });
  const n = e.query('t', {or:[{and:[{index:'txt',op:'startsWith',values:['a']}]}]}, 'count');
  return n >= 2 ? null : `startsWith('a') matched ${n}, expected >=2`;
});
// 6. undefined / NaN / Infinity
check('NaN + Infinity', () => {
  const id = e.add('t', { score: NaN, big: Infinity });
  const g = e.get('t', id);
  return (Number.isNaN(g.score) && g.big === Infinity) ? null : `NaN->${JSON.stringify(g.score)} Infinity->${JSON.stringify(g.big)}`;
});
// 7. numeric string vs number identity
check('string "36" vs number 36', () => {
  e.add('t', { score: 36 });
  const asNum = e.query('t', {or:[{and:[{index:'score',op:'equals',values:[36]}]}]}, 'count');
  const asStr = e.query('t', {or:[{and:[{index:'score',op:'equals',values:['36']}]}]}, 'count');
  return asNum >= 1 && asStr === 0 ? null : `number match=${asNum}, string match=${asStr} (type affinity leak)`;
});

// ---------------------------------------------------------------------------
// 8-13. Found by an adversarial pass AFTER 0.1.0 shipped. Every one of these was
// silent — wrong data or a bricked database, never an error. They are guards now.
// ---------------------------------------------------------------------------
const fresh = () => {
  const en = createEngine(A(new DatabaseSync(':memory:')));
  return en;
};

// 8. Adding an index in v2 that reuses a keyPath v1 already indexed used to
// throw "duplicate column name" and roll the migration back, because
// PRAGMA table_info does NOT list virtual generated columns. Fresh installs
// worked; every EXISTING database was permanently unopenable.
check('migration: v2 index reusing a v1 keyPath', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{f:'++id, name, age'}}]);
  en.add('f', { name:'a', age:3 });
  en.migrate([{version:1,stores:{f:'++id, name, age'}},{version:2,stores:{f:'++id, name, age, [name+age]'}}]);
  return en.query('f',{or:[]},'count') === 1 ? null : 'row lost across migration';
});
check('migration: making an existing index unique', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'++id, email'}}]);
  en.add('t', { email:'a@x' });
  en.migrate([{version:1,stores:{t:'++id, email'}},{version:2,stores:{t:'++id, &email'}}]);
  return null;
});

// 9. put() used INSERT OR REPLACE, which resolves ANY uniqueness conflict by
// DELETING the conflicting row. Putting a doc whose unique index collided with
// a DIFFERENT row destroyed that row silently. Dexie raises ConstraintError.
check('put() must not delete a row on a unique-index conflict', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, &email'}}]);
  en.put('t', { id:1, email:'a@x', name:'first' });
  let threw = false;
  try { en.put('t', { id:2, email:'a@x', name:'second' }); } catch { threw = true; }
  const rows = en.query('t',{or:[]},'docs');
  if (!threw) return 'no error raised on a unique conflict';
  return rows.length === 1 && rows[0].name === 'first' ? null : `row 1 destroyed: ${JSON.stringify(rows)}`;
});
check('put() still upserts on the primary key', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, &email'}}]);
  en.put('t', { id:1, email:'a@x' }); en.put('t', { id:1, email:'b@x' });
  const r = en.query('t',{or:[]},'docs');
  return r.length === 1 && r[0].email === 'b@x' ? null : JSON.stringify(r);
});

// 10. REPLACE's internal delete does not fire AFTER DELETE triggers, so the old
// multiEntry shadow rows survived and queries returned documents that no longer
// carried the tag.
check('multiEntry shadow must not keep stale rows across put()', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{f:'id, *tags'}}]);
  en.put('f', { id:1, tags:['red','blue'] });
  en.put('f', { id:1, tags:['green'] });
  const red = en.query('f',{or:[{and:[{index:'tags',op:'equals',values:['red']}]}]},'count');
  const green = en.query('f',{or:[{and:[{index:'tags',op:'equals',values:['green']}]}]},'count');
  return red === 0 && green === 1 ? null : `stale shadow: red=${red} green=${green}`;
});

// 11. json_patch matches KEYS, not paths, so a dotted change key wrote a junk
// top-level property and the real field never changed.
check('dotted keyPath in update() writes the real field', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, addr.city'}}]);
  en.put('t', { id:1, addr:{ city:'old', zip:1 } });
  en.update('t', 1, { 'addr.city':'NEW' });
  const d = en.get('t', 1);
  const hit = en.query('t',{or:[{and:[{index:'addr.city',op:'equals',values:['NEW']}]}]},'count');
  return d.addr.city === 'NEW' && d.addr.zip === 1 && hit === 1
    ? null : `doc=${JSON.stringify(d)} indexHits=${hit}`;
});

// 12. null/undefined are stored as TEXT sentinels and SQLite orders INTEGER
// before TEXT, so every open-ended range matched rows that had no value at all.
check('range queries exclude null and missing values', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, age'}}]);
  en.put('t',{id:1,age:30}); en.put('t',{id:2,age:null}); en.put('t',{id:3}); en.put('t',{id:4,age:10});
  const above = en.query('t',{or:[{and:[{index:'age',op:'above',values:[18]}]}]},'keys');
  const eqNull = en.query('t',{or:[{and:[{index:'age',op:'equals',values:[null]}]}]},'keys');
  return JSON.stringify(above) === '[1]' && JSON.stringify(eqNull) === '[2]'
    ? null : `above(18)=${JSON.stringify(above)} equals(null)=${JSON.stringify(eqNull)}`;
});

// 13. anyOf/noneOf skipped the codec, so anyOf([date]) silently returned nothing
// and anyOf([true]) threw — while the equivalent equals() worked.
check('anyOf goes through the value codec', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, when, flag'}}]);
  const d = new Date('2020-01-01');
  en.put('t',{id:1,when:d,flag:true}); en.put('t',{id:2,when:new Date('2021-01-01'),flag:false});
  const byDate = en.query('t',{or:[{and:[{index:'when',op:'anyOf',values:[d]}]}]},'keys');
  const byBool = en.query('t',{or:[{and:[{index:'flag',op:'anyOf',values:[true]}]}]},'keys');
  return JSON.stringify(byDate) === '[1]' && JSON.stringify(byBool) === '[1]'
    ? null : `anyOf(date)=${JSON.stringify(byDate)} anyOf(true)=${JSON.stringify(byBool)}`;
});

// 14. modifyWhere skipped encode(), so modify({x:null}) DELETED the key and a
// Date came back a string — while table.update() with the same change was fine.
check('modifyWhere goes through the value codec', () => {
  const en = fresh();
  en.migrate([{version:1,stores:{t:'id, name'}}]);
  en.put('t',{id:1,name:'a',note:'keep'});
  en.modifyWhere('t',{or:[]},{ note:null, when:new Date('2021-06-01') });
  const d = en.get('t', 1);
  return d.note === null && d.when instanceof Date ? null
    : `note=${JSON.stringify(d.note)} when=${Object.prototype.toString.call(d.when)}`;
});

console.log(bad.length ? 'FINDINGS:\n- ' + bad.join('\n- ') : 'no findings');
