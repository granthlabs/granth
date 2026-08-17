import type { Granth } from './index.js';

/** Subscribe a component to a live query. Re-runs when a table it read changes. */
export declare function useLiveQuery<T>(
  db: Granth,
  querier: () => Promise<T>,
  deps?: unknown[],
  initialValue?: T
): T | undefined;

/** Pre-bind the hook to one database, for the Dexie-like call shape. */
export declare function createLiveQueryHook(
  db: Granth
): <T>(querier: () => Promise<T>, deps?: unknown[], initialValue?: T) => T | undefined;

/** `false` on the server, `true` in a browser that can run the database. */
export declare function useIsSupported(): boolean;
