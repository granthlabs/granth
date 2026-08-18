# WhereClause

Returned by `table.where(index)`. Mirrors
[Dexie's `WhereClause`](https://dexie.org/docs/WhereClause/WhereClause) — **18/18 members covered**.

Every method returns a [`Collection`](./collection).

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

## Case-insensitive matching

`equalsIgnoreCase` / `startsWithIgnoreCase` / `anyOfIgnoreCase` fold with JavaScript's
`toLowerCase()`, registered into SQLite as a function — so they are **full Unicode**:
`equalsIgnoreCase('ÉCOLE')` matches `école`, and Greek, Cyrillic and Å-with-ring all
behave. (SQLite's built-in `lower()` folds `A-Z` and nothing else, which would make any
non-English search box silently under-match.)

The cost is that they cannot use the index. Fine at small scale; store a normalized
lowercase field and query that if it shows up in a profile.

::: warning Custom adapters
If you supply your own [`Adapter`](/storage), implement the optional `createFunction`
member — these three operators need it. Without it they fail loudly with
`no such function: granth_lower` rather than quietly returning too few rows.
:::

## Known limitation: lone surrogates

A string containing an unpaired surrogate (half of an emoji, typically from a truncated
string) **stores and reads back exactly**, but cannot be matched by `equals` or
`startsWith`. SQLite's JSON decoder and the driver's parameter binding encode it
differently, so the two sides of the comparison never meet. The query returns no rows —
it never returns wrong ones.
