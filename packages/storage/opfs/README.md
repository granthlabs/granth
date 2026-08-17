# granth-storage-opfs

OPFS storage backend for [granth](https://github.com/sundarshahi/granth).

Uses the `opfs-sahpool` VFS: the fastest OPFS backend and the only one that needs **no COOP/COEP**
headers. Writes land in place, so there is nothing to checkpoint. Requires a dedicated Worker —
OPFS sync access handles exist nowhere else.

```js
import { opfsStorage } from 'granth-storage-opfs';
startGranthWorker({ sqlite3InitModule, storage: [opfsStorage()] });
```

## Install

```bash
npm install granth-storage-opfs
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
