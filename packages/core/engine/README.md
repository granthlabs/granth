# @granth/engine

The storage engine behind [granth](https://github.com/sundarshahi/granth).

Schema parsing, the query planner, the SQL compiler and the value codec. Environment-agnostic:
give it an adapter with `{ all, exec, run }` and it works on sqlite-wasm in a worker or on
Node's `node:sqlite` in a test.

Documents are JSON in a `_doc` column; each declared index becomes a virtual generated column
over `json_extract` plus a real SQLite index. The codec preserves `Date`, `NaN`, `Infinity`,
`BigInt` and `null`, which plain JSON silently corrupts.

## Install

```bash
npm install @granth/engine
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
