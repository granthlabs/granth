import react from '@vitejs/plugin-react';
export default {
  plugins: [react()],
  // sqlite-wasm must not be pre-bundled — esbuild mangles its wasm loading.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: {
    // Deliberately NO COOP/COEP headers: proving opfs-sahpool works without
    // cross-origin isolation is the entire reason we picked that VFS.
    headers: {},
  },
};
