/**
 * Binary values: ArrayBuffer, every TypedArray, DataView — and the two that
 * cannot be stored.
 *
 * WHY THIS EXISTS: none of these were handled, and the failure was silent.
 * `isPlain()` in the codec saw a Uint8Array as an ordinary object, so `encode()`
 * walked it index by index and stored `{"0":37,"1":80,…}` — right bytes, wrong
 * type, about nine times the size. ArrayBuffer, Blob and File have no enumerable
 * properties at all, so they stored as `{}`: the data was gone, nothing threw,
 * and `get()` returned a plain object. IndexedDB keeps all of these through
 * structured clone, so a migrated app storing an avatar or a signature lost it
 * on the first write with no way to notice until someone opened the file.
 *
 * The interesting cases are not "do bytes survive". They are the ones where a
 * naive implementation looks right and is not: the constructor has to come back
 * (Float64Array and Uint8Array over the same bytes are different values), a view
 * onto a slice must store its own bytes rather than its whole backing buffer,
 * and the base64 has to be chunked or it throws on the first real file.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers } from 'granth-engine';
import { inlineRuntime } from 'granth-runtime-inline';
import { Granth } from 'granthdb';

const db = new DatabaseSync(':memory:');
const adapter = {
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (n, f) => db.function(n, { deterministic: true }, f),
};
const engine = createEngine(adapter);
const g = new Granth('bin', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
g.version(1).stores({ files: '++id, name' });
await g.open();

let n = 0;
const roundTrip = async (label, value) => {
  const id = await g.files.add({ name: label, body: value });
  const back = (await g.files.get(id)).body;
  assert.equal(back?.constructor?.name, value.constructor.name, `${label}: constructor`);
  const a = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const b = back instanceof ArrayBuffer ? new Uint8Array(back) : new Uint8Array(back.buffer, back.byteOffset, back.byteLength);
  assert.deepEqual([...b], [...a], `${label}: bytes`);
  n++;
};

// ---- every shape that has to survive
await roundTrip('ArrayBuffer', new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer);
await roundTrip('Uint8Array', new Uint8Array([0, 1, 254, 255]));
await roundTrip('Int8Array', new Int8Array([-128, 0, 127]));
await roundTrip('Uint8ClampedArray', new Uint8ClampedArray([0, 128, 255]));
await roundTrip('Int16Array', new Int16Array([-32768, 0, 32767]));
await roundTrip('Uint16Array', new Uint16Array([0, 65535]));
await roundTrip('Int32Array', new Int32Array([-2147483648, 2147483647]));
await roundTrip('Uint32Array', new Uint32Array([0, 4294967295]));
await roundTrip('Float32Array', new Float32Array([1.5, -2.25]));
await roundTrip('Float64Array', new Float64Array([Math.PI, -0.1]));
await roundTrip('BigInt64Array', new BigInt64Array([-9007199254740993n, 0n]));
await roundTrip('BigUint64Array', new BigUint64Array([18446744073709551615n]));
await roundTrip('DataView', new DataView(new Uint8Array([1, 2, 3, 4]).buffer));

// ---- the type must come back, not just the bytes.
// Uint8Array and Float64Array over identical bytes are different values, and
// decoding to the wrong one is a silent numeric change rather than an error.
const f = new Float64Array([1.5]);
const asBytes = new Uint8Array(f.buffer.slice(0));
const fId = await g.files.add({ name: 'typed', body: f });
const bId = await g.files.add({ name: 'raw', body: asBytes });
assert.ok((await g.files.get(fId)).body instanceof Float64Array, 'Float64Array stays a Float64Array');
assert.ok((await g.files.get(bId)).body instanceof Uint8Array, 'the same bytes as Uint8Array stay a Uint8Array');
n += 2;

// ---- a view onto a SLICE stores its own bytes, not the whole buffer.
// Otherwise subarray(0, 4) of a 10 MB buffer silently persists all 10 MB and
// reads back the wrong length.
const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
const slice = new Uint8Array(backing.buffer, 2, 3);
const sId = await g.files.add({ name: 'slice', body: slice });
const sBack = (await g.files.get(sId)).body;
assert.equal(sBack.length, 3, 'a view stores its own length');
assert.deepEqual([...sBack], [1, 2, 3], 'and its own bytes');
n += 2;

// ---- nested and in arrays, because encode() recurses
const nested = await g.files.add({ name: 'nested', meta: { thumb: new Uint8Array([7, 7]) }, parts: [new Uint8Array([1]), new Uint8Array([2])] });
const nBack = await g.files.get(nested);
assert.ok(nBack.meta.thumb instanceof Uint8Array, 'binary survives inside an object');
assert.deepEqual([...nBack.parts[1]], [2], 'and inside an array');
n += 2;

// ---- CHUNKED base64.
// `String.fromCharCode(...bytes)` spreads every byte as an argument and blows
// the stack around 100 kB — which passes every test written against a small
// fixture and throws on the first real file.
const big = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
const bigId = await g.files.add({ name: 'big', body: big });
const bigBack = (await g.files.get(bigId)).body;
assert.equal(bigBack.length, big.length, '1 MB survives');
assert.equal(bigBack[1048575], big[1048575], 'including the last byte');
n += 2;

// ---- Map, Set and RegExp: the rest of the same hole.
// `typeof x === 'object'` is true for all three, so isPlain() claimed them,
// encode() walked keys they do not expose, and each stored as `{}`. All three
// are structured-clone types, so IndexedDB round-trips them.
const mId = await g.files.add({
  name: 'collections',
  map: new Map([['a', 1], ['b', 'two']]),
  set: new Set([3, 'four']),
  re: /ab+c/gi,
});
const m = await g.files.get(mId);
assert.ok(m.map instanceof Map, 'a Map comes back a Map');
assert.deepEqual([...m.map], [['a', 1], ['b', 'two']], 'with its entries and order');
assert.ok(m.set instanceof Set, 'a Set comes back a Set');
assert.deepEqual([...m.set], [3, 'four'], 'with its members');
assert.ok(m.re instanceof RegExp, 'a RegExp comes back a RegExp');
assert.equal(m.re.source, 'ab+c', 'with its source');
assert.equal(m.re.flags, 'gi', 'and its flags');
n += 7;

// ---- and RECURSIVELY, or the container is fixed and the same bug survives
// one level down.
const rId = await g.files.add({
  name: 'nested collections',
  map: new Map([['when', new Date('2026-01-02T03:04:05.000Z')], ['bytes', new Uint8Array([1, 2, 3])]]),
  set: new Set([new Date('2020-06-01T00:00:00.000Z')]),
  deep: new Map([['inner', new Map([['n', 9007199254740993n]])]]),
});
const r = await g.files.get(rId);
assert.ok(r.map.get('when') instanceof Date, 'a Date inside a Map survives as a Date');
assert.equal(r.map.get('when').toISOString(), '2026-01-02T03:04:05.000Z', 'with its value');
assert.ok(r.map.get('bytes') instanceof Uint8Array, 'binary inside a Map survives');
assert.deepEqual([...r.map.get('bytes')], [1, 2, 3], 'with its bytes');
assert.ok([...r.set][0] instanceof Date, 'a Date inside a Set survives');
assert.equal(r.deep.get('inner').get('n'), 9007199254740993n, 'a Map inside a Map, holding a bigint');
n += 6;

// ---- empty ones are not missing ones
const zId = await g.files.add({ name: 'empty collections', map: new Map(), set: new Set() });
const z = await g.files.get(zId);
assert.ok(z.map instanceof Map && z.map.size === 0, 'an empty Map round-trips');
assert.ok(z.set instanceof Set && z.set.size === 0, 'an empty Set round-trips');
n += 2;

// ---- an empty buffer is not the same as a missing one
const eId = await g.files.add({ name: 'empty', body: new Uint8Array(0) });
const eBack = (await g.files.get(eId)).body;
assert.ok(eBack instanceof Uint8Array && eBack.length === 0, 'an empty Uint8Array round-trips');
n++;

// ---- Blob and File FAIL LOUDLY.
// Reading their bytes is asynchronous and the codec runs inside the write path,
// so they cannot be encoded. Before this they encoded to `{}` and the file was
// simply gone. A throw naming the fix is the kindest failure available.
for (const [label, value] of [
  ['Blob', new Blob([new Uint8Array([1, 2])])],
  ['File', new File([new Uint8Array([1, 2])], 'a.pdf')],
  ['a Blob nested in an object', { deep: { file: new Blob([new Uint8Array([1])]) } }],
]) {
  await assert.rejects(
    () => g.files.add({ name: label, body: value }),
    /cannot store a Blob or File/,
    `${label} must throw rather than store {}`
  );
  n++;
}

// ---- and the error says what to do instead
const err = await g.files.add({ name: 'x', body: new Blob(['x']) }).catch((e) => e);
assert.match(err.message, /arrayBuffer\(\)/, 'the error names the fix');
n++;

// ---- the cost is stated, because it decides whether this is the right place
// for your data at all. Base64 is 33% and it sits inside the row's JSON, so the
// whole document re-parses on every read.
const stored = db.prepare(`SELECT length("_doc") AS n FROM "files" ORDER BY length("_doc") DESC LIMIT 1`).get().n;
assert.ok(stored > 1_398_000 && stored < 1_410_000, `1 MB stores as ~1.33 MB of JSON, got ${stored}`);
n++;

await g.close();
console.log(`binary: ${n} checks (every structured-clone type round-trips; Blob and File fail loudly)`);
