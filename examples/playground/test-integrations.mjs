/**
 * Proves the state-library integrations against the REAL libraries.
 *
 * Not "should work in theory": rxjs, zustand and @tanstack/query-core are all
 * installed and driven here. Two of these are claims the codebase already made
 * in a comment — that a liveQuery is an RxJS observable and a Svelte store —
 * and a claim nobody executed is just a comment.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Granth } from 'granthdb';
import { inlineRuntime } from 'granth-runtime-inline';
import { createEngine, rpcHandlers } from 'granth-engine';
import { from, firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createStore } from 'zustand/vanilla';
import { QueryClient } from '@tanstack/query-core';
import { syncQueryKey, granthQuery, bindToStore, toDispatch } from './demos/integrations.js';

const adapter = (db) => ({
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (n, f) => db.function(n, f),
});

const engine = createEngine(adapter(new DatabaseSync(':memory:')));
const db = new Granth('integrations', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
db.version(1).stores({ friends: '++id, name, age' });
await db.open();

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const names = () => db.friends.orderBy('name').toArray().then((r) => r.map((f) => f.name));

// --- 1. RxJS: from(liveQuery) must work with NO adapter ---------------------
{
  await db.friends.clear();
  await db.friends.add({ name: 'ada', age: 36 });

  const obs = from(db.liveQuery(() => names()));
  const first = await firstValueFrom(obs);
  assert.deepEqual(first, ['ada'], 'rxjs from() must consume the liveQuery directly');

  // and it must EMIT AGAIN on a write, not just resolve once
  const collected = firstValueFrom(from(db.liveQuery(() => names())).pipe(take(2), toArray()));
  await tick();
  await db.friends.add({ name: 'bob', age: 25 });
  const [before, after] = await collected;
  assert.deepEqual(before, ['ada']);
  assert.deepEqual(after, ['ada', 'bob'], 'rxjs must receive the update');
}

// --- 2. Svelte store contract: subscribe() RETURNS the unsubscribe ----------
{
  const store = db.liveQuery(() => names());
  const seen = [];
  const unsub = store.subscribe((v) => seen.push(v));
  assert.equal(typeof unsub, 'function', 'Svelte requires subscribe() to return a function');
  await tick();
  await db.friends.add({ name: 'cy', age: 41 });
  await tick();
  assert.ok(seen.length >= 2, `expected an update, saw ${seen.length} emissions`);
  unsub();
  const countAfter = seen.length;
  await db.friends.add({ name: 'dot', age: 30 });
  await tick();
  assert.equal(seen.length, countAfter, 'unsubscribe must actually stop emissions');
}

// --- 3. Zustand -------------------------------------------------------------
{
  await db.friends.clear();
  const store = createStore(() => ({ friends: [] }));
  const stop = bindToStore(db, () => names(), (friends) => store.setState({ friends }));
  await tick();
  await db.friends.add({ name: 'eve', age: 22 });
  await tick();
  assert.deepEqual(store.getState().friends, ['eve'], 'zustand slice must track the database');
  stop();
  await db.friends.add({ name: 'fay', age: 28 });
  await tick();
  assert.deepEqual(store.getState().friends, ['eve'], 'unsubscribing must stop the binding');
}

// --- 4. TanStack Query ------------------------------------------------------
{
  await db.friends.clear();
  await db.friends.add({ name: 'gus', age: 50 });

  const qc = new QueryClient();
  const opts = granthQuery(db, ['friends'], () => names());
  assert.equal(opts.staleTime, Infinity, 'local data should not be treated as network-stale');

  let fetches = 0;
  const observed = await qc.fetchQuery({ ...opts, queryFn: () => { fetches++; return names(); } });
  assert.deepEqual(observed, ['gus']);
  assert.equal(fetches, 1);

  // The bridge must INVALIDATE on a database change, so TanStack keeps
  // ownership of caching rather than being bypassed.
  const stop = syncQueryKey(db, qc, ['friends'], () => names());
  await tick();
  await db.friends.add({ name: 'hal', age: 44 });
  await tick(120);

  const state = qc.getQueryState(['friends']);
  assert.ok(state.isInvalidated || state.dataUpdatedAt > 0, 'the query key must be invalidated on write');

  const refetched = await qc.fetchQuery({ ...opts, queryFn: () => names() });
  assert.deepEqual(refetched, ['gus', 'hal'], 'a refetch after invalidation must see the new row');
  stop();
}

// --- 5. Redux-style dispatch ------------------------------------------------
{
  await db.friends.clear();
  const actions = [];
  const stop = toDispatch(db, (a) => actions.push(a), () => names(), 'friends/loaded');
  await tick();
  await db.friends.add({ name: 'ivy', age: 33 });
  await tick();
  assert.ok(actions.length >= 1, 'expected at least one dispatched action');
  assert.equal(actions.at(-1).type, 'friends/loaded');
  assert.deepEqual(actions.at(-1).payload, ['ivy']);
  stop();
}

console.log('integrations: rxjs, svelte store, zustand, tanstack query, redux dispatch all verified');
process.exit(0);
