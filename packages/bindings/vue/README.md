# granth-vue

Vue bindings for [granth](https://github.com/granthlabs/granthlabs.github.io).

```js
import { useLiveQuery } from 'granth-vue';

const { data: friends } = useLiveQuery(db, () => db.friends.toArray(), { initialValue: [] });
```

Unsubscribes automatically with the component's effect scope. `vue` is an optional peer dependency.

## Install

```bash
npm install granth-vue
```

Full documentation: **https://granthlabs.github.io**

## License

MIT
