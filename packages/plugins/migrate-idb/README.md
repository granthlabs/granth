# @granth/plugin-migrate-idb

Migrate an existing IndexedDB or Dexie database into [granth](https://github.com/sundarshahi/granth).

```js
import { suggestSchema, importFromIndexedDB } from '@granth/plugin-migrate-idb';

db.version(1).stores(await suggestSchema('my-old-dexie-db'));
await db.open();
await importFromIndexedDB(db, { from: 'my-old-dexie-db' });
```

Reads the schema out of the real object stores (auto-increment, unique, multiEntry, compound),
preserves primary keys, rebuilds every index, and is idempotent. It does **not** delete the
source — verify first.

## Install

```bash
npm install @granth/plugin-migrate-idb
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
