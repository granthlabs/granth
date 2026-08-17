/**
 * Solid needs one small bridge: a live query is an observable, and Solid's
 * `from()` consumes exactly that shape — subscribe returning an unsubscribe.
 */
import { render } from 'solid-js/web';
import { from, createSignal, Show, For } from 'solid-js';
import { db, addTodo, toggle, remove, openTodos } from './todo-db.js';

function App() {
  const todos = from((set) => {
    const sub = db.liveQuery(() => openTodos()).subscribe(set);
    return () => sub.unsubscribe();
  });

  const [title, setTitle] = createSignal('');
  const submit = (e) => {
    e.preventDefault();
    if (!title().trim()) return;
    addTodo(title().trim());
    setTitle('');
  };

  return (
    <>
      <h2>Todos — Solid</h2>
      <p class="lede">solid-js <code>from()</code> takes the live query directly.</p>
      <form onSubmit={submit}>
        <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)}
               placeholder="What needs doing?" aria-label="New todo" />
        <button type="submit">Add</button>
      </form>
      <Show when={todos()} fallback={<p class="empty">Loading…</p>}>
        <Show when={todos().length} fallback={<p class="empty">No todos yet — add one above and the list updates itself.</p>}>
          <ul>
            <For each={todos()}>{(t) => (
              <li>
                <label>
                  <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
                  {t.title}
                </label>
                <button class="x" onClick={() => remove(t.id)} aria-label="Delete">×</button>
              </li>
            )}</For>
          </ul>
        </Show>
      </Show>
      <p class="count">{todos()?.length ?? 0} open</p>
    </>
  );
}

render(() => <App />, document.querySelector('main'));
