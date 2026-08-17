<script>
  import { db, addTodo, toggle, remove, openTodos } from './todo-db.js';

  // A live query IS a Svelte store: subscribe() returns its own unsubscribe,
  // which is exactly the store contract. No adapter, no wrapper — `$todos`
  // re-renders on every change, including writes from ANOTHER TAB.
  const todos = db.liveQuery(() => openTodos());

  let title = '';
  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    addTodo(title.trim());
    title = '';
  };
</script>

<h2>Todos — Svelte</h2>
<p class="lede">A live query is a Svelte store already. <code>$todos</code>, nothing else.</p>

<form on:submit={submit}>
  <input bind:value={title} placeholder="What needs doing?" aria-label="New todo" />
  <button type="submit">Add</button>
</form>

{#if $todos === undefined}
  <p class="empty">Loading…</p>
{:else if $todos.length === 0}
  <p class="empty">No todos yet — add one above and the list updates itself.</p>
{:else}
  <ul>
    {#each $todos as t (t.id)}
      <li>
        <label>
          <input type="checkbox" checked={t.done} on:change={() => toggle(t.id)} />
          {t.title}
        </label>
        <button class="x" on:click={() => remove(t.id)} aria-label="Delete">×</button>
      </li>
    {/each}
  </ul>
{/if}

<p class="count">{$todos?.length ?? 0} open</p>
