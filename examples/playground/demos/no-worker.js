// Proof that granth runs with NO Worker at all: the engine is created right here
// on the main thread and handed to the inline runtime.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Granth } from 'granthdb';
import { inlineRuntime } from 'granth-runtime-inline';
import { createEngine, rpcHandlers } from 'granth-engine';
import { indexeddbStorage } from 'granth-storage-indexeddb';
import { memoryStorage } from 'granth-storage-memory';

const createHandlers = async () => {
  const sqlite3 = await sqlite3InitModule();
  // OPFS is unavailable off a dedicated worker, so start at IndexedDB.
  const opts = { filename: '/no-worker.sqlite3', sqlite3, checkpointMs: 50 };
  const plugin = (await indexeddbStorage().isAvailable(sqlite3)) ? indexeddbStorage() : memoryStorage();
  const store = await plugin.open(opts);
  const engine = createEngine(store.adapter);
  const base = rpcHandlers(() => engine);
  return {
    ...base,
    storageKind: () => store.kind,
    flush: () => store.flush(),
    deleteDatabase: async () => { await store.destroy(); return true; },
    size: () => 0,
  };
};

const db = new Granth('no-worker-todos', { runtime: inlineRuntime({ createHandlers }) });
db.version(1).stores({ todos: '++id, title, done, created' });

const list = document.getElementById('list');
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const i = document.getElementById('t');
  if (!i.value.trim()) return;
  await db.todos.add({ title: i.value.trim(), done: false, created: new Date() });
  i.value = '';
});

db.liveQuery(() => db.todos.orderBy('created').toArray()).subscribe((todos) => {
  list.innerHTML = todos.length ? '' : '<li class="empty">Nothing yet.</li>';
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = t.done ? 'done' : '';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: t.done });
    box.addEventListener('change', async () => { await db.todos.update(t.id, { done: !t.done }); });
    const span = Object.assign(document.createElement('span'), { className: 't', textContent: t.title });
    const del = Object.assign(document.createElement('button'), { textContent: '×' });
    del.addEventListener('click', () => db.todos.delete(t.id));
    li.append(box, span, del);
    list.append(li);
  }
  document.getElementById('stats').textContent = `${todos.filter((t) => !t.done).length} open / ${todos.length} total`;
});

db.storageKind().then((k) => {
  document.getElementById('kind').textContent = `storage: ${k} · runtime: ${db.runtimeKind()} (no Worker)`;
});
