/**
 * DEFAULT CHOICE. Resolve from cache immediately; revalidate off the critical path.
 * The network leg never inflates user-visible latency.
 */
export declare function staleWhileRevalidate<T>(
  fromCache: () => Promise<T | undefined | null>,
  fromNetwork: () => Promise<T>,
  onFresh?: (value: T) => void
): Promise<T>;

/**
 * Cache and network race, first one wins. Use only when stale data is unacceptable:
 * it costs a network request on every read and a slow disk inflates latency directly.
 */
export declare function raceFirstWin<T>(
  fromCache: () => Promise<T | undefined | null>,
  fromNetwork: () => Promise<T>
): Promise<T>;

/**
 * Tail protection without doubling request volume: the network is only consulted
 * if the cache has not answered within `delayMs`. Idempotent reads only.
 */
export declare function hedge<T>(
  fromCache: () => Promise<T | undefined | null>,
  fromNetwork: () => Promise<T>,
  delayMs?: number
): Promise<T>;
