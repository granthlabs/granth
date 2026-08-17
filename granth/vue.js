// Vue binding. `vue` is an OPTIONAL peer dependency.
// (Angular and Svelte need nothing — see ./react.js for why.)

import { shallowRef, onScopeDispose, watch, isRef, unref } from 'vue';

/**
 * A live query as a Vue ref. Unsubscribes automatically with the effect scope.
 *
 * @param {import('./index.js').Granth} db
 * @param {() => Promise<T>} querier
 * @param {{ initialValue?: T, deps?: import('vue').Ref[] }} [opts]
 * @returns {{ data: import('vue').ShallowRef<T|undefined>, error: import('vue').ShallowRef<unknown> }}
 *
 * @example
 *   const { data: friends } = useLiveQuery(db, () => db.friends.toArray(), { initialValue: [] });
 */
export function useLiveQuery(db, querier, { initialValue = undefined, deps = [] } = {}) {
  const data = shallowRef(initialValue);
  const error = shallowRef(null);
  let stop = null;

  const start = () => {
    stop?.();
    const sub = db.liveQuery(() => querier()).subscribe({
      next: (v) => { data.value = v; error.value = null; },
      error: (e) => { error.value = e; },
    });
    stop = () => (typeof sub === 'function' ? sub() : sub.unsubscribe());
  };

  start();
  if (deps.length) watch(deps.map((d) => (isRef(d) ? d : () => unref(d))), start);
  onScopeDispose(() => stop?.());

  return { data, error };
}
