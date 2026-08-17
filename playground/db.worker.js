import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/playground.sqlite3',
  upgrades: {
    2: (engine) => {
      for (const f of engine.query('friends', { or: [] }, 'docs')) {
        if (f.city === undefined) engine.update('friends', f.id, { city: 'unknown' });
      }
    },
  },
});
