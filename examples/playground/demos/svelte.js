// Svelte 5 removed `new Component({ target })`; mounting goes through `mount()`.
// The component itself is unchanged — `$todos` still works, because a granth
// live query satisfies the store contract in Svelte 5 exactly as it did in 4.
import { mount } from 'svelte';
import Todo from './Todo.svelte';

mount(Todo, { target: document.querySelector('main') });
