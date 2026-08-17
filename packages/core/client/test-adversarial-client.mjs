import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers } from 'granth-engine';
import { serveInWorker } from 'opfs-leader/worker';
import { Granth } from 'granthdb';

const A = (db)=>({all:(s,p=[])=>db.prepare(s).all(...p).map(r=>({...r})),exec:s=>db.exec(s),
  run:(s,p=[])=>{const r=db.prepare(s).run(...p);return{changes:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid)}}});
function fakeWorker(){const engine=createEngine(A(new DatabaseSync(':memory:')));const L={message:[],error:[]};
  const scope={addEventListener:(t,f)=>scope._r=f,postMessage:m=>L.message.forEach(f=>f({data:m}))};
  serveInWorker(rpcHandlers(()=>engine),{scope});
  return{addEventListener:(t,f)=>L[t]?.push(f),postMessage:m=>scope._r({data:m}),terminate(){}};}
function makeLocks(){const st=new Map();const g=n=>{if(!st.has(n))st.set(n,{r:0,w:false,q:[]});return st.get(n)};
  function pump(n){const s=g(n);while(s.q.length){const h=s.q[0];const ok=h.mode==='exclusive'?!s.w&&s.r===0:!s.w;if(!ok)return;s.q.shift();
    if(h.mode==='exclusive')s.w=true;else s.r++;h.grant();}}
  return{request(name,o,f){const fn=typeof o==='function'?o:f;const mode=typeof o==='function'?'exclusive':(o?.mode??'exclusive');const s=g(name);
    return new Promise((res,rej)=>{s.q.push({mode,grant:async()=>{try{res(await fn())}catch(e){rej(e)}finally{if(mode==='exclusive')s.w=false;else s.r--;pump(name)}}});pump(name)})}};}

const bad=[]; const chk=async(n,f)=>{try{const r=await f(); if(r)bad.push(`${n}: ${r}`)}catch(e){bad.push(`${n}: THREW ${String(e.message).slice(0,100)}`)}};

const db = new Granth('adv', { worker: fakeWorker, locks: makeLocks() });
db.version(1).stores({ t: '++id, name, age, when, flag, *tags' });

await chk('Date through the client API', async () => {
  const id = await db.t.add({ name:'d', when: new Date('2021-05-05T00:00:00Z') });
  const g = await db.t.get(id);
  return g.when instanceof Date ? null : `Date -> ${typeof g.when}`;
});
await chk('boolean through the client API', async () => {
  const id = await db.t.add({ name:'b', flag: true });
  const g = await db.t.get(id);
  if (g.flag !== true) return `flag -> ${JSON.stringify(g.flag)}`;
  return (await db.t.where('flag').equals(true).count()) === 1 ? null : 'where(flag).equals(true) found none';
});
await chk('update to null (Dexie sets null)', async () => {
  const id = await db.t.add({ name:'n', age: 5 });
  await db.t.update(id, { age: null });
  const g = await db.t.get(id);
  return 'age' in g ? null : 'age key was deleted instead of set to null';
});
await chk('nested object survives a partial update', async () => {
  const id = await db.t.add({ name:'nest', meta:{ a:1, b:{ c:2 } } });
  await db.t.update(id, { meta:{ b:{ d:3 } } });
  const g = await db.t.get(id);
  return (g.meta?.a === 1 && g.meta?.b?.c === 2 && g.meta?.b?.d === 3) ? null : `merge lost data: ${JSON.stringify(g.meta)}`;
});
await chk('array value replaced not merged', async () => {
  const id = await db.t.add({ name:'arr', tags:['a','b','c'] });
  await db.t.update(id, { tags:['z'] });
  const g = await db.t.get(id);
  return JSON.stringify(g.tags) === '["z"]' ? null : `tags -> ${JSON.stringify(g.tags)}`;
});
await chk('unicode + emoji keys/values', async () => {
  const id = await db.t.add({ name:'日本語 🎉 emoji', tags:['🎉'] });
  const g = await db.t.get(id);
  if (g.name !== '日本語 🎉 emoji') return 'value mangled';
  return (await db.t.where('tags').equals('🎉').count()) === 1 ? null : 'emoji multiEntry lookup failed';
});
await chk('empty string / zero / false are not falsy-dropped', async () => {
  const id = await db.t.add({ name:'', age: 0, flag: false });
  const g = await db.t.get(id);
  return (g.name === '' && g.age === 0 && g.flag === false) ? null : `-> ${JSON.stringify(g)}`;
});
await chk('bulkAdd is atomic on failure', async () => {
  const before = await db.t.count();
  try { await db.t.bulkAdd([{ name:'ok1' }, null]); } catch {}
  const after = await db.t.count();
  return before === after ? null : `partial write: ${before} -> ${after}`;
});
await chk('injection via a value', async () => {
  const id = await db.t.add({ name: `x'); DROP TABLE t;--` });
  return (await db.t.get(id)).name.includes('DROP') ? null : 'value mangled';
});
console.log(bad.length ? 'CLIENT FINDINGS:\n- ' + bad.join('\n- ') : 'no client findings');
await db.close();

// An open BroadcastChannel keeps Node alive; exit explicitly so CI does not hang.
process.exit(0);
