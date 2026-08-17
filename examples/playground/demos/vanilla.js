import { db, addTodo, toggle, remove } from './todo-db.js';

const list = document.getElementById('list');
const stats = document.getElementById('stats');

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('t');
  if (!input.value.trim()) return;
  await addTodo(input.value.trim());
  input.value = '';
});

// subscribe() returns an unsubscribe function AND carries .unsubscribe() —
// so the same object works as a Svelte store and as an RxJS-style subscription.
db.liveQuery(() => db.todos.orderBy('created').toArray()).subscribe((todos) => {
  list.innerHTML = todos.length ? '' : '<li class="empty">Nothing yet.</li>';
  for (const t of todos) {
    const li = document.createElement('li');
    li.className = t.done ? 'done' : '';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: t.done });
    box.addEventListener('change', () => toggle(t.id));
    const span = Object.assign(document.createElement('span'), { className: 't', textContent: t.title });
    const del = Object.assign(document.createElement('button'), { textContent: '×' });
    del.addEventListener('click', () => remove(t.id));
    li.append(box, span, del);
    list.append(li);
  }
  stats.textContent = `${todos.filter((t) => !t.done).length} open / ${todos.length} total`;
});

db.storageKind().then((k) => (document.getElementById('kind').textContent = `storage: ${k} · runtime: ${db.runtimeKind()}`));
