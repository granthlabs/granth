# @granth/vue

Vue bindings for [granth](https://github.com/sundarshahi/granth).

```js
import { useLiveQuery } from '@granth/vue';

const { data: friends } = useLiveQuery(db, () => db.friends.toArray(), { initialValue: [] });
```

Unsubscribes automatically with the component's effect scope. `vue` is an optional peer dependency.

## Install

```bash
npm install @granth/vue
```

Full documentation: **https://sundarshahi.github.io/granth**

## License

MIT
