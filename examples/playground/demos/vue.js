import { createApp, ref, h } from 'vue';
import { useLiveQuery } from '@granth/vue';
import { db, addTodo, toggle, remove } from './todo-db.js';

createApp({
  setup() {
    // Unsubscribes automatically with the component's effect scope.
    const { data: todos } = useLiveQuery(db, () => db.todos.orderBy('created').toArray(), { initialValue: [] });
    const text = ref('');
    const submit = async (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      await addTodo(text.value.trim());
      text.value = '';
    };
    return () =>
      h('div', [
        h('h1', 'Todos — Vue'),
        h('p', { class: 'sub' }, [h('code', 'useLiveQuery'), ' composable from ', h('code', '@granth/vue'), '.']),
        h('form', { onSubmit: submit }, [
          h('input', {
            type: 'text', value: text.value, placeholder: 'What needs doing?',
            onInput: (e) => (text.value = e.target.value),
          }),
          h('button', { class: 'primary' }, 'Add'),
        ]),
        h('ul', [
          todos.value.length === 0 ? h('li', { class: 'empty' }, 'Nothing yet.') : null,
          ...todos.value.map((t) =>
            h('li', { key: t.id, class: t.done ? 'done' : '' }, [
              h('input', { type: 'checkbox', checked: t.done, onChange: () => toggle(t.id) }),
              h('span', { class: 't' }, t.title),
              h('button', { onClick: () => remove(t.id) }, '×'),
            ])
          ),
        ]),
        h('div', { class: 'meta' }, `${todos.value.filter((t) => !t.done).length} open / ${todos.value.length} total`),
      ]);
  },
}).mount('#app');
