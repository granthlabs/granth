/**
 * Ledger — the second showcase app's data layer.
 *
 * Deliberately not another list-with-facets. An issue tracker shows filtering
 * and paging; money shows three things it cannot:
 *
 *   - a transfer is TWO writes that must both land or neither, which is what a
 *     transaction is actually for;
 *   - balances are an aggregate over a filtered set, recomputed rather than
 *     cached, so they cannot drift from the rows;
 *   - "this account, that month" is a range on a compound index — the shape a
 *     single-index cursor store handles worst.
 *
 * Amounts are integer PENCE, never floats. 0.1 + 0.2 is not 0.3 in binary
 * floating point, and a ledger that is a penny out is a broken ledger.
 */
import Granth from 'granthdb';

export const db = new Granth('granth-ledger', {
  worker: () => new Worker(new URL('./ledger.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  // `[account+date]` is the index the app leans on: every view is one account
  // over one span of time. `date` alone stays for the all-accounts view.
  entries: '++id, account, date, category, amount, [account+date]',
});

export const ACCOUNTS = ['current', 'savings', 'card'];
export const CATEGORIES = ['salary', 'rent', 'food', 'transport', 'bills', 'fun', 'transfer'];
export const SEED_COUNT = 12_000;

/** Deterministic, so every visitor sees the same ledger and the same totals. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const PAYEES = {
  salary: ['Acme Ltd', 'Contract work'],
  rent: ['Landlord'],
  food: ['Corner shop', 'Big supermarket', 'Coffee place', 'Bakery'],
  transport: ['Rail', 'Bus pass', 'Fuel'],
  bills: ['Electric', 'Water', 'Broadband', 'Phone'],
  fun: ['Cinema', 'Bookshop', 'Records', 'Pub'],
  transfer: ['Transfer'],
};

/** ISO date strings sort lexicographically, which is what makes them a usable index key. */
const iso = (d) => d.toISOString().slice(0, 10);

export function makeEntries(count) {
  const r = rng(7);
  const out = [];
  const end = new Date('2026-08-01T00:00:00Z');
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  const span = end - start;

  for (let i = 0; i < count; i++) {
    const when = new Date(start.getTime() + r() * span);
    const account = ACCOUNTS[Math.floor(r() * ACCOUNTS.length)];
    // Salary is rare and large; food is frequent and small. Uniform amounts make
    // every aggregate look the same and prove nothing.
    const roll = r();
    const category =
      roll < 0.04 ? 'salary' :
      roll < 0.08 ? 'rent' :
      roll < 0.42 ? 'food' :
      roll < 0.58 ? 'transport' :
      roll < 0.74 ? 'bills' : 'fun';
    const magnitude =
      category === 'salary' ? 180_000 + Math.floor(r() * 90_000) :
      category === 'rent' ? 95_000 :
      category === 'bills' ? 3_000 + Math.floor(r() * 9_000) :
      category === 'transport' ? 200 + Math.floor(r() * 4_800) :
      category === 'fun' ? 600 + Math.floor(r() * 6_000) :
      250 + Math.floor(r() * 4_500);

    out.push({
      account,
      date: iso(when),
      category,
      payee: PAYEES[category][Math.floor(r() * PAYEES[category].length)],
      amount: category === 'salary' ? magnitude : -magnitude,
    });
  }
  // Seeded in date order so the table looks like a ledger before anyone sorts it.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** Money in, money out and the net, for whatever set of rows is on screen. */
export function totals(rows) {
  let inp = 0, out = 0;
  for (const e of rows) (e.amount > 0 ? (inp += e.amount) : (out += e.amount));
  return { in: inp, out, net: inp + out };
}

export const money = (pence) =>
  `${pence < 0 ? '−' : ''}£${(Math.abs(pence) / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export async function ensureSeeded() {
  const n = await db.entries.count();
  if (n >= SEED_COUNT) return { seeded: false, count: n, ms: 0 };
  const t = performance.now();
  await db.entries.clear();
  await db.entries.bulkAdd(makeEntries(SEED_COUNT));
  return { seeded: true, count: SEED_COUNT, ms: performance.now() - t };
}

/**
 * Move money between accounts, as ONE transaction.
 *
 * The point of the demo: two rows, and there is no state of the database where
 * one exists without the other. Both writes go through a single `rw`
 * transaction, so a failure between them rolls the first one back rather than
 * leaving money that has left one account without arriving at the other.
 */
export async function transfer({ from, to, pence, date }) {
  if (from === to) throw new Error('pick two different accounts');
  if (!(pence > 0)) throw new Error('amount must be positive');
  return db.transaction('rw', db.entries, async (tx) => {
    await tx.entries.add({ account: from, date, category: 'transfer', payee: `To ${to}`, amount: -pence });
    await tx.entries.add({ account: to, date, category: 'transfer', payee: `From ${from}`, amount: pence });
    return true;
  });
}
