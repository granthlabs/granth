import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startLitieWorker } from 'litie/worker';

startLitieWorker({
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
