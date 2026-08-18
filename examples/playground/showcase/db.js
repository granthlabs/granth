/**
 * The showcase app's data layer.
 *
 * A real app, not a demo: ~5,000 issues, the query shapes an issue tracker
 * actually needs, and a volume where the difference between a query planner and
 * a cursor walk is something you can feel rather than read about.
 */
import Granth from 'granthdb';

export const db = new Granth('granth-showcase', {
  worker: () => new Worker(new URL('./showcase.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  // `status` and `updated` are indexed separately BECAUSE the app filters on one
  // and orders by the other — the thing a single-index cursor store cannot do in
  // one pass. `*labels` is multiEntry for the facet counts.
  issues: '++id, status, priority, assignee, updated, *labels, [status+priority]',
  // A second table so the transaction demo has somewhere real to write.
  activity: '++id, issueId, at',
});

const STATUS = ['open', 'in-progress', 'blocked', 'done'];
const PRIORITY = ['p0', 'p1', 'p2', 'p3'];
const PEOPLE = ['ada', 'grace', 'radia', 'barbara', 'margaret', 'joan', 'annie', 'katherine'];
const LABELS = ['bug', 'perf', 'ui', 'docs', 'infra', 'security', 'a11y', 'flaky'];
const SUBJECTS = [
  'Race in the leader election', 'Paging returns duplicate rows', 'Slow first paint on cold cache',
  'Index not used for compound lookup', 'Worker fails to load under CSP', 'Migration bricks existing files',
  'Timeout is reported as success', 'Retry applies the write twice', 'Search misses accented names',
  'Reverse order ignores the bound index', 'Empty state renders as a blank slab', 'Focus ring missing on the picker',
];

/** Deterministic PRNG, so the seeded data is identical on every visit. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296));
}

export function makeIssues(count) {
  const r = rng(20260818);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const now = Date.UTC(2026, 7, 18);
  const out = [];
  for (let i = 0; i < count; i++) {
    const labels = [...new Set([pick(LABELS), pick(LABELS)])];
    out.push({
      title: `${pick(SUBJECTS)} (#${i + 1})`,
      status: pick(STATUS),
      priority: pick(PRIORITY),
      assignee: pick(PEOPLE),
      // Spread over ~180 days so ordering by date is meaningful.
      updated: new Date(now - Math.floor(r() * 180 * 86400_000)),
      labels,
      comments: Math.floor(r() * 40),
    });
  }
  return out;
}

export const SEED_COUNT = 5000;

/** Idempotent: the database survives reloads, so only seed an empty one. */
export async function ensureSeeded() {
  const have = await db.issues.count();
  if (have >= SEED_COUNT) return { seeded: false, count: have, ms: 0 };
  await db.issues.clear();
  const t0 = performance.now();
  await db.issues.bulkAdd(makeIssues(SEED_COUNT));
  return { seeded: true, count: SEED_COUNT, ms: performance.now() - t0 };
}

export { STATUS, PRIORITY, PEOPLE, LABELS };
