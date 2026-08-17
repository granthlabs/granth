/**
 * Bridges to the state libraries people already use.
 *
 * The design goal is that granthdb should not need an adapter at all: a
 * liveQuery is already an observable (Symbol.observable), already a Svelte
 * store (subscribe returns an unsubscribe function), and already exposes
 * .unsubscribe() for RxJS and Angular. Those three cover most of the ecosystem
 * for free.
 *
 * The two below exist because their libraries want something a plain observable
 * is not: TanStack Query owns its own cache and wants to be TOLD to refetch,
 * and Zustand wants a setter called. Both are a few lines each — deliberately
 * small enough to copy into your codebase rather than take as a dependency.
 */

/**
 * TanStack Query: keep a query key in sync with the database.
 *
 * Rather than replacing the query, this drives INVALIDATION. TanStack keeps
 * ownership of caching, retries, suspense and devtools, and granthdb just tells
 * it when the underlying rows changed — including changes made in another tab.
 *
 * @returns an unsubscribe function
 */
export function syncQueryKey(db, queryClient, queryKey, querier, opts) {
  const sub = db.liveQuery(querier, opts).subscribe(
    () => { queryClient.invalidateQueries({ queryKey }); },
    (err) => { queryClient.setQueryData(queryKey, () => { throw err; }); }
  );
  return () => sub.unsubscribe();
}

/**
 * The queryFn half. Pairing this with syncQueryKey gives a normal useQuery that
 * happens to be backed by a local database.
 *
 *   const opts = granthQuery(db, ['friends'], () => db.friends.toArray());
 *   const { data } = useQuery(opts);
 */
export function granthQuery(db, queryKey, querier) {
  return {
    queryKey,
    queryFn: () => querier(),
    // The data is local; a network-shaped staleness policy just causes
    // redundant reads. Invalidation is driven by the database instead.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  };
}

/**
 * Zustand: push query results into a slice.
 *
 * Call inside your store factory. Returns an unsubscribe so a store that is
 * torn down does not leave a live query running.
 *
 *   const useStore = create((set) => {
 *     bindToStore(db, () => db.friends.toArray(), (friends) => set({ friends }));
 *     return { friends: [] };
 *   });
 */
export function bindToStore(db, querier, apply, opts) {
  const sub = db.liveQuery(querier, opts).subscribe(
    (rows) => apply(rows),
    (err) => { console.error('granthdb: live query failed', err); }
  );
  return () => sub.unsubscribe();
}

/**
 * Anything with a Redux-style dispatch: emit an action per change.
 *
 *   toDispatch(db, store.dispatch, () => db.friends.toArray(), 'friends/loaded');
 */
export function toDispatch(db, dispatch, querier, type, opts) {
  const sub = db.liveQuery(querier, opts).subscribe(
    (payload) => dispatch({ type, payload }),
    (error) => dispatch({ type: `${type}/error`, error: true, payload: error })
  );
  return () => sub.unsubscribe();
}
