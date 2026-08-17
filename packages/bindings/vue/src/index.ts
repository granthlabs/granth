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
export function useLiveQuery<T>(
  db: { liveQuery: (q: () => Promise<T>) => { subscribe: (o: { next: (v: T) => void; error: (e: unknown) => void }) => (() => void) & { unsubscribe?: () => void } } },
  querier: () => Promise<T>,
  { initialValue = undefined, deps = [] }: { initialValue?: T; deps?: unknown[] } = {}
) {
  const data = shallowRef<T | undefined>(initialValue);
  const error = shallowRef<unknown>(null);
  let stop: (() => void) | null = null;

  const start = () => {
    stop?.();
    const sub = db.liveQuery(() => querier()).subscribe({
      next: (v) => { data.value = v; error.value = null; },
      error: (e) => { error.value = e; },
    });
    stop = () => (typeof sub === 'function' ? sub() : (sub as { unsubscribe: () => void }).unsubscribe());
  };

  start();
  if (deps.length) watch(deps.map((d) => (isRef(d) ? d : () => unref(d))) as never, start);
  onScopeDispose(() => stop?.());

  return { data, error };
}
