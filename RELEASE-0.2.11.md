# granthdb 0.2.11

**Binary and collection values were being silently destroyed. If you store an
avatar, a signature, a thumbnail, a `Map` or a `RegExp` in a row, upgrade.**

## The bug

granthdb stores documents as JSON with a codec that preserves the structured
clone types JSON would lose — `Date`, `NaN`, `Infinity`, `BigInt`, `undefined`.
Every type it did not enumerate fell through and was destroyed without an error:

| You stored | 0.2.10 gave back |
|---|---|
| `Uint8Array([37, 80])` | `{"0":37,"1":80}` — right bytes, wrong type, ~9× the size |
| `ArrayBuffer`, `DataView` | `{}` |
| `Blob`, `File` | `{}` — surfaces later as an empty download |
| `Map`, `Set` | `{}` |
| `RegExp` | `{}` |

Nothing threw, because `JSON.stringify` does not throw on any of it. IndexedDB
preserves all of these through structured clone, so an app migrating from Dexie
lost them on the first write with no way to notice until someone opened the file.

The cause was one predicate. `typeof x === 'object'` is true for all of them, so
the "is this a plain object I should walk?" check claimed them and the encoder
walked keys they do not expose.

## Fixed

`ArrayBuffer`, all twelve typed arrays, `DataView`, `Map`, `Set` and `RegExp`
now round-trip exactly — recursively, so a `Map` of `Date`s or a `Set` of
`Uint8Array`s survives intact.

The constructor is stored alongside the data: a `Float64Array` and a
`Uint8Array` over identical bytes are different values, and decoding to the
wrong one is a silent numeric change rather than an error.

```js
await db.files.add({ name: 'sig.png', bytes: new Uint8Array(await blob.arrayBuffer()) });
(await db.files.get(id)).bytes instanceof Uint8Array;   // true
```

## Two deliberate exceptions

**`Blob` and `File` now throw**, naming the fix. Reading their bytes is
asynchronous and the codec runs inside the write path, so it cannot encode one.
A loud error at the write beats a file that vanished:

```js
// before: stored {}, no error
await db.files.add({ file });

// now
await db.files.add({ bytes: new Uint8Array(await file.arrayBuffer()) });
```

**`Error` still stores as `{}`.** It is structured-cloneable, but a
round-tripped Error loses its stack and gains a different prototype, so
restoring one would be a half-truth. Store a message and a code.

## Know the cost before you use it

Bytes are base64 inside the row's JSON: **+33%**, and the whole document
re-parses on every read of that row. Right for an avatar or a signature; wrong
for a PDF or a video. For those, keep the bytes in OPFS and the metadata in
granthdb — the pattern is written out in
[Files and binary data](https://granthlabs.github.io/files-and-binary), along
with why OPFS is *not* the user's disk and which browsers can actually reach it
(Chromium desktop only).

## Also in this release

- **[`granth-mcp`](https://granthlabs.github.io/mcp)** — an MCP server that lets
  a coding assistant run granthdb code against a throwaway database instead of
  guessing at the API from Dexie. `claude mcp add granth -- npx -y granth-mcp`
- **`DEXIE_WAIVERS` and `DEXIE_DIVERGENCES`** are exported. The first is the
  eight Dexie members granth deliberately does not implement; the second is the
  names that exist here and mean something else — currently `use()`, which is an
  addon hook rather than DBCore middleware. Writing the MCP server's test is what
  found that: `use` had sat in the waiver list described as "no equivalent" while
  it had been implemented all along, and the parity audit structurally could not
  see it.
- **[Notion's architecture, documented properly](https://granthlabs.github.io/cache-first-apps)**
  — what they actually built, why corruption came before the single-writer
  design, and their fix for the slow-device p95 regression, which is worth
  stealing.
- **[Use cases](https://granthlabs.github.io/use-cases)** — start from the
  symptom you are seeing, including the cases where this is the wrong tool.

## Upgrading

```bash
npm install granthdb@0.2.11
```

No API changes and no migration. Rows written by 0.2.10 that contain a mangled
binary value cannot be recovered from the database — the bytes for an
`ArrayBuffer` or a `Blob` were never written. A `Uint8Array` stored as
`{"0":37,…}` is recoverable: `new Uint8Array(Object.values(broken))`.
