import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '@granth/engine';
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
console.log(bad.length ? 'FINDINGS:\n- ' + bad.join('\n- ') : 'no findings');
