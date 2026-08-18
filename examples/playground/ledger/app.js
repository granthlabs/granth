/**
 * Ledger — UI.
 *
 * Every number on screen is computed from a query that just ran. Nothing is
 * cached in a variable and nudged: balances come back out of the database after
 * each write, because a balance that is maintained separately from the rows it
 * summarises is a balance that will eventually disagree with them.
 */
import { db, ensureSeeded, transfer, totals, money, ACCOUNTS, CATEGORIES, SEED_COUNT } from './db.js';

const $ = (id) => document.getElementById(id);
const PAGE = 25;

const state = { account: 'all', category: 'all', from: '2026-01-01', to: '2026-08-01', page: 0 };

/**
 * The query the current filters describe.
 *
 * Written as one place rather than inline at each call site: the table, the
 * totals and the pager must all be looking at the SAME set, and three copies of
 * "the current filter" is how they stop being.
 */
function collection() {
  const { account, from, to } = state;
  // The compound index earns its keep here — one account over one date range is
  // a single seek, not a scan filtered afterwards.
  let c = account === 'all'
    ? db.entries.where('date').between(from, to, true, true)
    : db.entries.where('[account+date]').between([account, from], [account, to], true, true);
  if (state.category !== 'all') c = c.filter((e) => e.category === state.category);
  return c;
}

async function balances() {
  // Per account, from the rows. `.toArray()` then sum, rather than a stored
  // running total that could drift away from what the table says.
  const out = {};
  for (const a of ACCOUNTS) {
    const rows = await db.entries.where('account').equals(a).toArray();
    out[a] = rows.reduce((n, e) => n + e.amount, 0);
  }
  return out;
}

function renderBalances(map) {
  $('balances').innerHTML = '';
  for (const a of ACCOUNTS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'facet' + (state.account === a ? ' is-on' : '');
    el.innerHTML = `<span>${a}</span><span class="facet__n">${money(map[a] ?? 0)}</span>`;
    el.addEventListener('click', () => {
      state.account = state.account === a ? 'all' : a;
      state.page = 0;
      render();
    });
    $('balances').appendChild(el);
  }
}

function renderRows(rows) {
  const body = $('rows');
  body.innerHTML = '';
  for (const e of rows) {
    const tr = document.createElement('tr');
    const amt = document.createElement('td');
    amt.className = 'num ' + (e.amount > 0 ? 'in' : 'out');
    amt.textContent = money(e.amount);
    tr.innerHTML =
      `<td class="mono">${e.date}</td>` +
      `<td>${e.payee}</td>` +
      `<td><span class="chip">${e.category}</span></td>` +
      `<td class="mono">${e.account}</td>`;
    tr.appendChild(amt);
    body.appendChild(tr);
  }
}

async function render() {
  const t = performance.now();
  // Two collections, not one cloned twice: `Collection.clone()` is one of the
  // two Dexie methods granthdb deliberately does not implement, and a collection
  // is single-use. `collection()` is a factory precisely so this is cheap.
  const [rows, all] = await Promise.all([
    collection().offset(state.page * PAGE).limit(PAGE).toArray(),
    collection().toArray(),
  ]);
  const took = performance.now() - t;

  const sums = totals(all);
  $('t-in').textContent = money(sums.in);
  $('t-out').textContent = money(sums.out);
  $('t-net').textContent = money(sums.net);
  $('t-net').className = 'stat__n ' + (sums.net >= 0 ? 'in' : 'out');

  $('timing').textContent = `${all.length.toLocaleString('en-GB')} entries · ${took.toFixed(1)} ms`;
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  $('page-label').textContent = `Page ${state.page + 1} of ${pages}`;
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page >= pages - 1;

  const empty = all.length === 0;
  $('empty').hidden = !empty;
  $('table-wrap').hidden = empty;
  if (!empty) renderRows(rows);

  renderBalances(await balances());
}

function wire() {
  const sel = $('category');
  for (const c of ['all', ...CATEGORIES]) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c === 'all' ? 'All categories' : c;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { state.category = sel.value; state.page = 0; render(); });

  for (const [id, key] of [['from', 'from'], ['to', 'to']]) {
    $(id).value = state[key];
    $(id).addEventListener('change', () => { state[key] = $(id).value; state.page = 0; render(); });
  }

  $('prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); render(); });
  $('next').addEventListener('click', () => { state.page += 1; render(); });

  $('transfer').addEventListener('click', async () => {
    const btn = $('transfer');
    btn.disabled = true;
    try {
      await transfer({ from: 'current', to: 'savings', pence: 5_000, date: '2026-08-01' });
      $('note').textContent = 'Moved £50.00 from current to savings — two rows, one transaction.';
    } catch (err) {
      $('note').textContent = String(err.message);
    } finally {
      btn.disabled = false;
      render();
    }
  });

  $('reseed').addEventListener('click', async () => {
    const btn = $('reseed');
    btn.disabled = true;
    $('note').textContent = 'Reseeding…';
    await db.entries.clear();
    const r = await ensureSeeded();
    $('note').textContent = `Reseeded ${r.count.toLocaleString('en-GB')} entries in ${r.ms.toFixed(0)} ms.`;
    btn.disabled = false;
    render();
  });
}

(async () => {
  wire();
  await db.open();
  const kind = await db.storageKind();
  const r = await ensureSeeded();
  $('env').textContent = `${kind} · worker · ${SEED_COUNT.toLocaleString('en-GB')} entries`;
  $('env').className = 'badge badge--ok';
  $('note').textContent = r.seeded
    ? `Seeded ${r.count.toLocaleString('en-GB')} entries in ${r.ms.toFixed(0)} ms.`
    : `Opened an existing database of ${r.count.toLocaleString('en-GB')} entries.`;
  await render();
  // Another tab writing shows up here, because one tab owns the database and
  // tells the rest what changed.
  db.onChange(() => render());
  window.__READY__ = true;
})().catch((err) => {
  $('note').textContent = `Failed: ${err.message}`;
  window.__READY__ = 'error';
});
