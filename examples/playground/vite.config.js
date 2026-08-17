import react from '@vitejs/plugin-react';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import solid from 'vite-plugin-solid';
export default {
  // solid() must precede react(): both claim .jsx, and whichever runs first wins.
  // Scoped by directory so each only compiles its own demo.
  plugins: [
    solid({ include: ['**/demos/solid.jsx'] }),
    react({ include: ['**/demos/react.jsx'] }),
    svelte(),
  ],
  // sqlite-wasm must not be pre-bundled — esbuild mangles its wasm loading.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: {
    // Deliberately NO COOP/COEP headers: proving opfs-sahpool works without
    // cross-origin isolation is the entire reason we picked that VFS.
    headers: {},
  },
};
