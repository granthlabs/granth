import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = (p) => resolve(here, p);

/**
 * The sandbox and the framework demos are BUILT into the docs site, so the
 * hosted docs and the runnable examples deploy as one artifact. They used to
 * exist only under `vite dev` on a laptop — the site's only reference to the
 * sandbox was a GitHub source link, which shows HTML, not a running database.
 *
 * index.html IS shipped — it is the verification suite, and letting someone prove
 * OPFS durability in their own browser is worth more than any claim on the docs
 * site. It only auto-runs when ?phase= is present, which is how CI drives it, so
 * a visitor gets an explanation and a button instead of a destructive surprise.
 *
 * Still NOT shipped: compat.html, stress.html and bench.html — harnesses that
 * auto-run on load with no idle state, driven from the dev server.
 */
const HOSTED = {
  verify: page('index.html'),
  showcase: page('showcase/index.html'),
  ledger: page('ledger/index.html'),
  sandbox: page('sandbox.html'),
  demos: page('demos/index.html'),
  vanilla: page('demos/vanilla.html'),
  react: page('demos/react.html'),
  vue: page('demos/vue.html'),
  svelte: page('demos/svelte.html'),
  solid: page('demos/solid.html'),
  'no-worker': page('demos/no-worker.html'),
};

export default defineConfig(({ command }) => ({
  // Dev is root-served and every browser suite drives it that way; the built
  // copy lands under the docs site's own base. Getting this wrong is invisible
  // locally and 404s everything in production — the same trap link-check exists
  // for on the docs side.
  // Mirrors the docs base — see docs/.vitepress/config.ts. Both must agree, so
  // both read the same variable.
  base: command === 'build' ? `${process.env.DOCS_BASE ?? '/'}play/` : '/',

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

  build: {
    // Written INTO the VitePress output, so `docs:build` must run VitePress
    // FIRST — VitePress empties its own dist and would delete this.
    outDir: resolve(here, '../../docs/.vitepress/dist/play'),
    emptyOutDir: true,
    rollupOptions: { input: HOSTED },
    chunkSizeWarningLimit: 3000,
  },

  server: {
    // Deliberately NO COOP/COEP headers: proving opfs-sahpool works without
    // cross-origin isolation is the entire reason we picked that VFS.
    headers: {},
  },
}));
