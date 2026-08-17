---
layout: home
hero:
  name: granth
  text: SQLite in the browser
  tagline: A Dexie-compatible API over SQLite/WASM on OPFS. Real indexes, a real query planner, off the main thread — and it runs without a Worker when it has to.
  actions:
    - theme: brand
      text: Get started
      link: /Tutorial
    - theme: alt
      text: Migrating from Dexie
      link: /MigratingFromDexie
    - theme: alt
      text: GitHub
      link: https://github.com/sundarshahi/granth
features:
  - title: Dexie-compatible
    details: The API is diffed against the real dexie package by a generated audit that fails the build on regression — WhereClause 18/18. Run npx @granth/codemod to migrate your source, then import your existing IndexedDB data.
  - title: A real query planner
    details: Filter on one index and order by another. A cursor-based store can only use one index per query; SQL has no such limit.
  - title: Structured-clone fidelity
    details: Date, NaN, Infinity, BigInt and null survive round-trips. Plain JSON silently corrupts all of them — an adversarial pass caught exactly that.
  - title: Safe across tabs
    details: One elected tab owns the database via Web Locks; every other tab routes to it. Two tabs writing one OPFS file is what corrupted Notion's first WASM-SQLite rollout.
  - title: Degrades instead of throwing
    details: Storage is an ordered plugin list — OPFS, then IndexedDB, then memory. Safari private browsing has no OPFS at all, so the fallback is the difference between working and crashing.
  - title: Everything is a plugin
    details: Storage, runtime and addons are separate packages behind a types-only protocol. Add, remove or replace any of them at runtime.
---
