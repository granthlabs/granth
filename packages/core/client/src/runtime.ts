/**
 * `granth/runtime` — runtime plugins, kept out of the default entry.
 *
 * The worker runtime is reachable via the `worker:` shorthand on the client, so
 * importing this is only necessary when choosing a runtime explicitly — most
 * often the inline one, which runs without a Worker.
 */

export { workerRuntime } from 'granth-runtime-worker';
export { inlineRuntime } from 'granth-runtime-inline';
export type { RuntimePlugin, RuntimeConnection } from 'granth-protocol';
