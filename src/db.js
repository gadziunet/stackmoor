import Database from 'better-sqlite3';

// Kolejne migracje schematu. Nowe zmiany dopisujemy na końcu listy,
// nigdy nie edytujemy już istniejących (numer = PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE stacks (
    name         TEXT PRIMARY KEY,
    auto_volumes INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE operations (
    id          INTEGER PRIMARY KEY,
    stack       TEXT NOT NULL,
    action      TEXT NOT NULL,
    status      TEXT NOT NULL,
    output      TEXT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX operations_stack ON operations(stack, id DESC);
  `,
];

export const DEFAULT_SETTINGS = {
  // Właściciel folderów tworzonych automatycznie dla danych aplikacji.
  puid: 1000,
  pgid: 1000,
  // Ścieżki hosta, których panel NIE przepina do folderu stacka
  // (np. biblioteki multimediów). Nie są objęte backupem.
  hostPathAllowlist: ['/mnt', '/media'],
};

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }

  // Operacje przerwane restartem panelu nie mogą wisieć jako "running".
  db.prepare(
    `UPDATE operations SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'`
  ).run();

  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) {
      try { out[key] = JSON.parse(value); } catch { /* zostaje domyślna */ }
    }
  }
  return out;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS) stmt.run(key, JSON.stringify(value));
    }
  })();
  return getSettings(db);
}
