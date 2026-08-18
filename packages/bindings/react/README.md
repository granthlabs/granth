# granth-react

React bindings for [granth](https://github.com/granthlabs/granthlabs.github.io).

```jsx
import { useLiveQuery, useIsSupported } from 'granth-react';

const friends = useLiveQuery(db, () => db.friends.orderBy('name').toArray(), [], []);
```

Built on `useSyncExternalStore` with a server snapshot, so it is SSR-safe and cannot cause a
hydration mismatch. `react` is an optional peer dependency.

## Install

```bash
npm install granth-react
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
