// React binding. The ONLY framework that needs one:
//   - Svelte   `$liveQuery(...)` works directly — subscribe() returns an unsubscribe
//              function, which IS the Svelte store contract.
//   - Angular  `from(db.liveQuery(...))` works via Symbol.observable.
//   - Vue      see ./vue.js.
// React has no store contract, so it needs useSyncExternalStore.
//
// `react` is an OPTIONAL peer dependency: importing 'granth' never pulls this in.

import { useSyncExternalStore, useMemo, useRef, useCallback } from 'react';

const PENDING = Symbol('granth.pending');

/**
 * Subscribe a component to a live query.
 *
 * @param {import('./index.js').Granth} db
 * @param {() => Promise<T>} querier  re-runs whenever a table it read changes
 * @param {any[]} [deps]              re-subscribe when these change (like useEffect)
 * @param {T} [initialValue]          returned before the first result arrives
 * @returns {T | undefined}
 *
 * @example
 *   const friends = useLiveQuery(db, () => db.friends.where('age').above(18).toArray(), [], []);
 */
export function useLiveQuery(db, querier, deps = [], initialValue = undefined) {
  const state = useRef({ value: PENDING, error: null });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(() => querier, deps);

  const subscribe = useCallback(
    (onChange) => {
      const sub = db.liveQuery(query).subscribe({
        next: (value) => { state.current = { value, error: null }; onChange(); },
        error: (error) => { state.current = { ...state.current, error }; onChange(); },
      });
      // subscribe() is dual-shaped; either form works.
      return () => (typeof sub === 'function' ? sub() : sub.unsubscribe());
    },
    [db, query]
  );

  const getSnapshot = useCallback(() => state.current, []);
  // Third argument is the SERVER snapshot: without it, React 18 throws during SSR.
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (snap.error) throw snap.error; // let the nearest error boundary handle it
  return snap.value === PENDING ? initialValue : snap.value;
}

/**
 * Pre-bind the hook to one database, for the Dexie-like call shape.
 *
 * @example
 *   // db.js
 *   export const db = new Granth('myapp', { worker: () => new Worker(...) });
 *   export const useLiveQuery = createLiveQueryHook(db);
 *
 *   // Component.jsx
 *   const friends = useLiveQuery(() => db.friends.toArray(), [], []);
 */
export function createLiveQueryHook(db) {
  return (querier, deps = [], initialValue = undefined) =>
    useLiveQuery(db, querier, deps, initialValue);
}

/**
 * `false` on the server, `true` in a browser that can run the database.
 * Uses the server snapshot so it cannot cause a hydration mismatch — render a
 * fallback while it is false instead of crashing the server render.
 */
export function useIsSupported() {
  return useSyncExternalStore(
    () => () => {},
    () => typeof globalThis.navigator?.locks?.request === 'function',
    () => false
  );
}
