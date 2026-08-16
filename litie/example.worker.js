// Example worker file — this is the whole thing.
// Constructed ONLY in the tab opfs-leader elects, so it is the single writer.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startLitieWorker } from './worker.js';

startLitieWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',

  // Optional data transforms, run after the schema migration that crosses each version.
  // They live here rather than in the client because a function cannot cross postMessage.
  upgrades: {
    2: (engine) => {
      for (const f of engine.query('friends', { or: [] }, 'docs')) {
        if (!f.city && f.address) engine.update('friends', f.id, { city: f.address.city });
      }
    },
  },
});
