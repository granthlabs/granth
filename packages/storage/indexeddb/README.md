# @granth/storage-indexeddb

IndexedDB storage backend for [granth](https://github.com/sundarshahi/granth).

The fallback that keeps apps working where OPFS does not exist — most importantly **Safari private
browsing, which exposes none at all**.

It is the same SQLite engine, not a second implementation: an in-memory database whose bytes are
checkpointed into IndexedDB. Every query, index, trigger and migration behaves identically; only
durability differs. Checkpoints are debounced and whole-file, so cost is O(database size).

## Install

```bash
npm install @granth/storage-indexeddb
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
