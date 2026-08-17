import type { Ref, ShallowRef } from 'vue';
import type { Granth } from './index.js';

/** A live query as a Vue ref. Unsubscribes with the effect scope. */
export declare function useLiveQuery<T>(
  db: Granth,
  querier: () => Promise<T>,
  opts?: { initialValue?: T; deps?: Array<Ref<unknown> | (() => unknown)> }
): { data: ShallowRef<T | undefined>; error: ShallowRef<unknown> };
