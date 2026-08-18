/**
 * Signals — an issue tracker built on granth, used as the showcase.
 *
 * It exists to be a REAL app rather than a feature list: 5,000 rows, the query
 * shapes a tracker actually needs, and every number on screen measured from the
 * query that just ran rather than quoted from a benchmark.
 */
import { db, ensureSeeded, SEED_COUNT, STATUS, PRIORITY, PEOPLE, LABELS } from './db.js';

const $ = (id) => document.getElementById(id);
const PAGE = 25;

const state = {
  status: 'all',
  priority: 'all',
  assignee: 'all',
  label: null,
  search: '',
  sort: 'updated',
  desc: true,
  page: 0,
};

/** Build the query from the current filters. Returns a Collection, unexecuted. */
function query() {
  let c;
  // The headline: filter on ONE index and order by ANOTHER, in a single pass.
  if (state.label) c = db.issues.where('labels').equals(state.label);
  else if (state.status !== 'all') c = db.issues.where('status').equals(state.status);
  else if (state.assignee !== 'all') c = db.issues.where('assignee').equals(state.assignee);
  else c = db.issues.toCollection();

  // Everything not covered by the leading index becomes a predicate. A cursor
  // store would have to walk and discard; here it rides along with the scan.
  if (state.status !== 'all' && (state.label || state.assignee !== 'all')) {
    c = c.filter((i) => i.status === state.status);
  }
  if (state.assignee !== 'all' && state.label) c = c.filter((i) => i.assignee === state.assignee);
  if (state.priority !== 'all') c = c.filter((i) => i.priority === state.priority);
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    c = c.filter((i) => i.title.toLowerCase().includes(q));
  }
  return c;
}

const fmtDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

function row(issue) {
  const tr = document.createElement('tr');
  const labels = issue.labels.map((l) => `<button class="tag" data-label="${l}">${l}</button>`).join(' ');
  tr.innerHTML =
    `<td class="t">${issue.title.replace(/</g, '&lt;')}</td>` +
    `<td><span class="pill pill--${issue.status}">${issue.status}</span></td>` +
    `<td><span class="prio prio--${issue.priority}">${issue.priority}</span></td>` +
    `<td>${issue.assignee}</td>` +
    `<td class="labels">${labels}</td>` +
    `<td class="num">${issue.comments}</td>` +
    `<td class="num">${fmtDate(issue.updated)}</td>`;
  return tr;
}

function setState(patch, { resetPage = true } = {}) {
  Object.assign(state, patch);
  if (resetPage) state.page = 0;
  render();
}

/** Facet counts come from the database, not from a client-side tally. */
async function renderFacets() {
  const counts = await Promise.all(
    STATUS.map(async (s) => [s, await db.issues.where('status').equals(s).count()])
  );
  $('facets').innerHTML = counts
    .map(([s, n]) => `<button class="facet${state.status === s ? ' is-on' : ''}" data-status="${s}">
        <span>${s}</span><span class="facet__n">${n.toLocaleString()}</span></button>`)
    .join('');
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const t0 = performance.now();

  const c = query();
  const total = await c.count();
  if (token !== renderToken) return; // a newer render already started

  // `.orderBy('updated')`, NOT `.reverse()`. reverse() flips the BOUND index —
  // which here is `status`, because that is what we filtered on — so it gave
  // status order backwards, not newest-first. Ordering by a different index than
  // you filtered on is the whole point, and it has to be asked for by name.
  // Caught by running this app over real data; the dates were visibly unsorted.
  const ordered = state.sort === 'updated' ? c.orderBy('updated') : c;
  const sorted = state.sort === 'updated' && state.desc ? ordered.reverse() : ordered;

  let rows = await sorted.offset(state.page * PAGE).limit(PAGE).toArray();
  if (token !== renderToken) return;

  // `sortBy` is client-side by definition, so only reach for it off the index.
  if (state.sort !== 'updated') {
    rows = rows.sort((a, b) => (a[state.sort] > b[state.sort] ? 1 : -1) * (state.desc ? -1 : 1));
  }

  const ms = performance.now() - t0;
  $('timing').textContent = `${total.toLocaleString()} match · ${ms.toFixed(1)} ms`;

  const body = $('rows');
  body.innerHTML = '';
  if (!rows.length) {
    $('empty').hidden = false;
    $('empty-title').textContent = total === 0 && !state.search && state.status === 'all' && !state.label
      ? 'No issues yet'
      : 'Nothing matches these filters';
    $('empty-body').textContent = total === 0 && !state.search && state.status === 'all' && !state.label
      ? 'Seed the database to explore 5,000 issues.'
      : 'Try clearing the search box, or pick a different status or label.';
    $('table-wrap').hidden = true;
  } else {
    $('empty').hidden = true;
    $('table-wrap').hidden = false;
    for (const r of rows) body.appendChild(row(r));
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));
  $('page-label').textContent = `Page ${state.page + 1} of ${pages.toLocaleString()}`;
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page + 1 >= pages;
  $('active-label').hidden = !state.label;
  if (state.label) $('active-label').textContent = `label: ${state.label} ✕`;
  await renderFacets();
  // A completed-render counter, so a test can wait for THIS render rather than
  // guess with a sleep. Without it the suite read the table before the filtered
  // render had painted and reported a filter bug that did not exist.
  window.__RENDERS__ = (window.__RENDERS__ ?? 0) + 1;
}

// ---- wiring ---------------------------------------------------------------

$('search').addEventListener('input', (e) => setState({ search: e.target.value }));
$('priority').addEventListener('change', (e) => setState({ priority: e.target.value }));
$('assignee').addEventListener('change', (e) => setState({ assignee: e.target.value }));
$('sort').addEventListener('change', (e) => setState({ sort: e.target.value }));
$('dir').addEventListener('click', () => {
  state.desc = !state.desc;
  $('dir').textContent = state.desc ? 'Newest first' : 'Oldest first';
  setState({});
});
$('facets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (b) setState({ status: state.status === b.dataset.status ? 'all' : b.dataset.status, label: null });
});
$('rows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-label]');
  if (b) setState({ label: b.dataset.label });
});
$('active-label').addEventListener('click', () => setState({ label: null }));
$('prev').addEventListener('click', () => setState({ page: Math.max(0, state.page - 1) }, { resetPage: false }));
$('next').addEventListener('click', () => setState({ page: state.page + 1 }, { resetPage: false }));

// A write that another tab will see, proving the live query is cross-tab.
$('triage').addEventListener('click', async () => {
  const btn = $('triage');
  btn.disabled = true;
  try {
    const oldest = await db.issues.where('status').equals('open').limit(5).toArray();
    if (!oldest.length) return;
    // One atomic batch across two tables — the transaction is the point.
    await db.transaction((tx) => {
      for (const i of oldest) {
        tx.issues.update(i.id, { status: 'in-progress', updated: new Date() });
        tx.activity.add({ issueId: i.id, at: new Date(), what: 'triaged' });
      }
    });
  } finally { btn.disabled = false; }
});

$('reseed').addEventListener('click', async () => {
  const btn = $('reseed');
  btn.disabled = true;
  $('status').textContent = 'Reseeding…';
  try {
    await db.issues.clear();
    await db.activity.clear();
    const r = await ensureSeeded();
    $('status').textContent = `Seeded ${r.count.toLocaleString()} issues in ${r.ms.toFixed(0)} ms`;
    setState({ page: 0 });
  } finally { btn.disabled = false; }
});

for (const [id, values] of [['priority', PRIORITY], ['assignee', PEOPLE]]) {
  $(id).innerHTML = `<option value="all">All ${id === 'priority' ? 'priorities' : 'assignees'}</option>` +
    values.map((v) => `<option value="${v}">${v}</option>`).join('');
}
$('labels').innerHTML = LABELS.map((l) => `<button class="tag" data-label="${l}">${l}</button>`).join(' ');
$('labels').addEventListener('click', (e) => {
  const b = e.target.closest('[data-label]');
  if (b) setState({ label: state.label === b.dataset.label ? null : b.dataset.label });
});

(async () => {
  try {
    const t0 = performance.now();
    const seed = await ensureSeeded();
    const [storage, runtime] = await Promise.all([db.storageKind(), db.runtimeKind()]);
    $('env').textContent = `${storage} · ${runtime} · ${(await db.issues.count()).toLocaleString()} issues`;
    $('env').className = 'badge badge--good';
    $('status').textContent = seed.seeded
      ? `Seeded ${SEED_COUNT.toLocaleString()} issues in ${seed.ms.toFixed(0)} ms`
      : `Opened in ${(performance.now() - t0).toFixed(0)} ms — data survived the reload`;
    await render();

    // `onChange`, NOT a liveQuery over count().
    //
    // The obvious-looking `liveQuery(() => db.issues.count())` is a trap for this
    // job: liveQuery only emits when its RESULT differs, and triaging an issue
    // changes a status, not the row count — so nothing re-rendered even though
    // the data had changed. That dedupe is correct and desirable; count() is just
    // the wrong thing to watch. onChange is the raw "something in these tables
    // changed" signal, which is what a whole-view refresh actually wants.
    db.onChange(() => render());
    window.__SHOWCASE_READY__ = true;
  } catch (err) {
    $('env').textContent = 'unavailable';
    $('env').className = 'badge badge--bad';
    $('status').textContent = `Could not open a database: ${err.message}`;
    window.__SHOWCASE_ERROR__ = String(err.message);
  }
})();
