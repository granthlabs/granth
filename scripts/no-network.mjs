/**
 * Make every outbound network call throw, for verifying the suite is offline-safe.
 *
 *     NODE_OPTIONS="--import ./scripts/no-network.mjs" npm test
 *
 * Preferred over pulling the interface down: this proves the suite issues ZERO
 * requests, rather than proving it survives them failing. A test that retries or
 * swallows a network error would still pass a "turn off the wifi" check and
 * still couple this repo's CI to someone else's server.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const boom = (what) => {
  throw new Error(
    `no-network: ${what} was called, but this run is meant to be offline. ` +
      `Tests must not depend on the network — see scripts/refresh-docs-surface.mjs ` +
      `for the pattern (fetch deliberately, commit the result).`
  );
};

globalThis.fetch = () => boom('fetch()');
http.request = () => boom('http.request()');
http.get = () => boom('http.get()');
https.request = () => boom('https.request()');
https.get = () => boom('https.get()');

// Anything reaching for a socket directly, except loopback — the browser suite
// and vite dev servers are legitimately local.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  const host = String(opts?.host ?? 'localhost');
  if (!/^(localhost|127\.|::1|0\.0\.0\.0)/.test(host)) boom(`a TCP connection to ${host}`);
  return connect.apply(this, args);
};
