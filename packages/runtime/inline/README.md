# granth-runtime-inline

No-Worker runtime for [granth](https://github.com/granthlabs/granth).

Runs the database on the calling thread, for strict CSP without `worker-src`, embedded contexts,
SSR, Node and tests.

Two limits, stated rather than hidden: it **cannot use OPFS** (sync access handles are
dedicated-worker-only, so pair it with IndexedDB or memory), and SQL runs on the calling thread,
so a slow query blocks rendering. Cross-tab change notification still works.

## Install

```bash
npm install granth-runtime-inline
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
