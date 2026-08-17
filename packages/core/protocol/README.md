# @granth/protocol

Plugin contracts for [granth](https://github.com/sundarshahi/granth).

Types only — zero runtime, zero dependencies. Storage backends, runtimes and bindings implement
these so they never have to import each other or the client.

```ts
import type { StoragePlugin, RuntimePlugin, Adapter } from '@granth/protocol';
```

Three extension points: `StoragePlugin` (where the bytes live), `RuntimePlugin` (where the SQL
executes), and addons registered with `db.use()`.

## Install

```bash
npm install @granth/protocol
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
