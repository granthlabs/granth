# granth-runtime-worker

The default runtime for [granth](https://github.com/granthlabs/granthlabs.github.io).

Runs SQL in a dedicated Worker owned by exactly one tab, elected via Web Locks by `opfs-leader`.
Every other tab routes its calls to that tab.

This is the only runtime that can use OPFS, and the only one that keeps SQL off the main thread.
Two tabs writing one OPFS file is what corrupted Notion's first WASM-SQLite rollout — this is the
fix, not a mitigation.

## Install

```bash
npm install granth-runtime-worker
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
