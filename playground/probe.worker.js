// Diagnostic only: reports how far sqlite-wasm setup gets inside a real worker.
const say = (step, extra = {}) => self.postMessage({ step, ...extra });

try {
  say('worker-start');
  const mod = await import('@sqlite.org/sqlite-wasm');
  say('module-imported', { keys: Object.keys(mod) });

  const sqlite3InitModule = mod.default;
  say('init-calling', { type: typeof sqlite3InitModule });

  const sqlite3 = await sqlite3InitModule();
  say('init-done', { version: sqlite3?.version?.libVersion, hasInstall: typeof sqlite3?.installOpfsSAHPoolVfs });

  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'probe-pool' });
  say('pool-installed', { capacity: pool.getCapacity?.(), files: pool.getFileCount?.() });

  const db = new pool.OpfsSAHPoolDb('/probe.sqlite3');
  db.exec('CREATE TABLE IF NOT EXISTS t(a)');
  db.exec("INSERT INTO t VALUES ('hello')");
  say('db-ok', { rows: db.selectValue('SELECT count(*) FROM t') });
  db.close();
} catch (err) {
  say('ERROR', { message: err?.message ?? String(err), stack: String(err?.stack ?? '').slice(0, 500) });
}
