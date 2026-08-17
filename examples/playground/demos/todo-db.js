// One shared database for every framework demo, so the only thing that differs
// between them is the binding — which is the point of the comparison.
import { Granth } from 'granthdb';

export const db = new Granth('demo-todos', {
  worker: () => new Worker(new URL('./todo.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({ todos: '++id, title, done, created, *tags' });

export const addTodo = (title, tags = []) =>
  db.todos.add({ title, done: false, created: new Date(), tags });

export const toggle = async (id) => {
  const t = await db.todos.get(id);
  return db.todos.update(id, { done: !t.done });
};

export const remove = (id) => db.todos.delete(id);
export const clearDone = () => db.todos.where('done').equals(true).delete();
/** Sorted by an index that is NOT the one being filtered on. */
export const openTodos = () => db.todos.where('done').equals(false).orderBy('created').toArray();
