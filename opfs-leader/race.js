// The p95 half of the Notion lesson: a local cache is not automatically faster.
// Firefox reached the same conclusion independently (RCWN) and ended up turning
// racing OFF on mobile. See wiki/concepts/cache-network-race.md.

/**
 * DEFAULT CHOICE. Resolve from cache immediately; revalidate off the critical path.
 * The network leg never inflates user-visible latency — which is the exact failure
 * a race is trying to fix.
 *
 * @param {Function} fromCache  () => Promise<T | undefined>
 * @param {Function} fromNetwork () => Promise<T>
 * @param {Function} [onFresh]  called with the network value when it lands
 */
export async function staleWhileRevalidate(fromCache, fromNetwork, onFresh) {
  const revalidate = fromNetwork();
  if (onFresh) revalidate.then(onFresh, () => {}); // stale-if-error: keep serving cache
  else revalidate.catch(() => {});

  const cached = await fromCache().catch(() => undefined);
  return cached !== undefined && cached !== null ? cached : revalidate;
}

/**
 * What Notion shipped. Use only when stale data is unacceptable.
 * Costs a network request on every read, and a slow disk directly inflates latency.
 */
export function raceFirstWin(fromCache, fromNetwork) {
  const net = fromNetwork();
  const cache = fromCache().then((v) => {
    if (v === undefined || v === null) return net; // a miss must not "win" the race
    return v;
  });
  return Promise.race([cache, net]);
}

/**
 * Tail protection without doubling request volume: only reach for the network if
 * the cache hasn't answered within `delayMs`. Read-heavy idempotent calls only.
 */
export function hedge(fromCache, fromNetwork, delayMs = 100) {
  const pending = () => new Promise(() => {}); // lose the race without rejecting it
  let answered = false;

  const cache = fromCache().then(
    (v) => {
      if (v === undefined || v === null) return pending();
      answered = true;
      return v;
    },
    () => pending() // a cache error is a miss; let the network answer
  );

  // Promise.race does NOT cancel the loser, so the timer alone would still fire
  // the network on every read — which is the request-doubling hedging exists to avoid.
  // ponytail: a cache MISS waits the full delayMs before the network starts.
  // Acceptable while misses are rare; if they aren't, resolve a miss into the
  // network leg immediately instead of holding it pending.
  const delayed = new Promise((resolve) => setTimeout(resolve, delayMs)).then(() =>
    answered ? pending() : fromNetwork()
  );

  return Promise.race([cache, delayed]);
}
