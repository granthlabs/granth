# WhereClause

Returned by `table.where(index)`. Mirrors
[Dexie's `WhereClause`](https://dexie.org/docs/WhereClause/WhereClause) — **18/18 members covered**.

Every method returns a [`Collection`](./Collection.md).

## Equality

| Method | Example |
|---|---|
| `equals(value)` | `.where('name').equals('ada')` |
| `equalsIgnoreCase(value)` | `.where('name').equalsIgnoreCase('ADA')` |
| `notEqual(value)` | `.where('name').notEqual('ada')` |
| `anyOf(values)` | `.where('name').anyOf(['ada', 'bob'])` |
| `anyOfIgnoreCase(values)` | `.where('name').anyOfIgnoreCase(['ADA'])` |
| `noneOf(values)` | `.where('name').noneOf(['ada'])` |

On a **compound index**, pass the tuple as an array:

```js
await db.friends.where('[name+age]').equals(['ada', 36]).first();
```

## Ranges

| Method | Example |
|---|---|
| `above(v)` / `aboveOrEqual(v)` | `.where('age').above(30)` |
| `below(v)` / `belowOrEqual(v)` | `.where('age').below(18)` |
| `between(lo, hi, incLo = true, incHi = false)` | `.where('age').between(18, 65, true, true)` |
| `inAnyRange([[a,b], [c,d]])` | `.where('age').inAnyRange([[0,18],[65,120]])` |

## Prefix

| Method | Example |
|---|---|
| `startsWith(prefix)` | `.where('name').startsWith('a')` |
| `startsWithIgnoreCase(prefix)` | |
| `startsWithAnyOf(prefixes)` | `.where('name').startsWithAnyOf(['a','b'])` |
| `startsWithAnyOfIgnoreCase(prefixes)` | |

## Null checks *(not in Dexie)*

`isNull()` · `notNull()`

## multiEntry indexes

On a `*tags` index, every operator means *"any element matches"*:

```js
db.version(1).stores({ friends: '++id, name, *tags' });
await db.friends.where('tags').equals('math').toArray();     // has 'math'
await db.friends.where('tags').startsWith('ma').toArray();   // has a tag starting 'ma'
```

Unlike Dexie you do **not** need `.distinct()` — a document is returned once no matter how many
of its array elements match.

## Performance note

`equalsIgnoreCase` / `startsWithIgnoreCase` / `anyOfIgnoreCase` apply `lower()` and therefore do
not use the index. Fine at small scale; store a normalized lowercase field if it shows up in a
profile.
