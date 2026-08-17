import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { createLiveQueryHook, useIsSupported } from 'granth-react';
import { db, addTodo, toggle, remove } from './todo-db.js';

// Bind the hook to one database once, for the Dexie-like call shape.
const useLive = createLiveQueryHook(db);

function App() {
  const supported = useIsSupported();          // false during SSR — no hydration mismatch
  const todos = useLive(() => db.todos.orderBy('created').toArray(), [], []);
  const [text, setText] = useState('');

  if (!supported) return <p className="empty">This browser cannot run the database.</p>;

  return (
    <>
      <h1>Todos — React</h1>
      <p className="sub">
        <code>useLiveQuery</code> from <code>granth-react</code>, backed by <code>useSyncExternalStore</code>.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await addTodo(text.trim());
          setText('');
        }}
      >
        <input type="text" value={text} placeholder="What needs doing?" onChange={(e) => setText(e.target.value)} />
        <button className="primary">Add</button>
      </form>
      <ul>
        {todos.length === 0 && <li className="empty">Nothing yet.</li>}
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
            <span className="t">{t.title}</span>
            <button onClick={() => remove(t.id)}>×</button>
          </li>
        ))}
      </ul>
      <div className="meta">
        <span>{todos.filter((t) => !t.done).length} open / {todos.length} total</span>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
