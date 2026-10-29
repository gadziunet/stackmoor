import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, getSettings, saveSettings } from './db.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession,
  sessionMiddleware, requireAuth, requireAppHeader, loginRateLimit,
} from './auth.js';
import { createStacks, UserError } from './stacks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT || 5001),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  stacksDir: path.resolve(process.env.STACKS_DIR || '/opt/stacks'),
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.stacksDir, { recursive: true });

const db = openDb(path.join(config.dataDir, 'panel.db'));
const stacks = createStacks({ db, stacksDir: config.stacksDir, getSettings: () => getSettings(db) });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware(db));
app.use('/api', requireAppHeader);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;

// Strumień tekstowy (wyjście docker compose na żywo).
function openStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (s) => { if (!res.writableEnded) res.write(s); };
}

function abortOnClose(req, res) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
  return ctl.signal;
}

// ---------- konto ----------

app.get('/api/state', (req, res) => {
  res.json({ needsSetup: !hasUsers(), user: req.user ? { username: req.user.username } : null });
});

app.post('/api/setup', loginRateLimit, (req, res) => {
  if (hasUsers()) return res.status(409).json({ error: 'Konto administratora już istnieje.' });
  const username = String(req.body.username || '').trim();
  const password = req.body.password;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Login: 3–32 znaki, litery, cyfry, ".", "_" lub "-".' });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const r = db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  createSession(db, r.lastInsertRowid, req, res);
  res.json({ ok: true });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
  }
  createSession(db, user.id, req, res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  destroySession(db, req, res);
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.post('/api/password', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current || ''), user.password_hash)) {
    return res.status(400).json({ error: 'Obecne hasło jest nieprawidłowe.' });
  }
  const pwErr = validatePassword(req.body.next);
  if (pwErr) return res.status(400).json({ error: pwErr });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.next), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  createSession(db, user.id, req, res);
  res.json({ ok: true });
});

// ---------- ustawienia ----------

app.get('/api/settings', (_req, res) => res.json({ ...getSettings(db), stacksDir: config.stacksDir }));

app.put('/api/settings', (req, res) => {
  const patch = {};
  for (const key of ['puid', 'pgid']) {
    if (req.body[key] !== undefined) {
      const n = Number(req.body[key]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return res.status(400).json({ error: `${key.toUpperCase()} musi być liczbą 0–65535.` });
      }
      patch[key] = n;
    }
  }
  if (req.body.hostPathAllowlist !== undefined) {
    const list = Array.isArray(req.body.hostPathAllowlist) ? req.body.hostPathAllowlist : [];
    const clean = list.map((p) => String(p).trim()).filter(Boolean);
    const bad = clean.find((p) => !p.startsWith('/') || p === '/');
    if (bad) return res.status(400).json({ error: `Nieprawidłowa ścieżka: "${bad}" (musi być bezwzględna i nie może być "/").` });
    patch.hostPathAllowlist = clean;
  }
  res.json(saveSettings(db, patch));
});

// ---------- stacki ----------

app.get('/api/stacks', wrap(async (_req, res) => res.json(await stacks.list())));

app.post('/api/stacks', wrap(async (req, res) => {
  const result = await stacks.save(req.body.name, req.body, { create: true });
  res.status(201).json(result);
}));

app.get('/api/stacks/:name', wrap(async (req, res) => res.json(await stacks.get(req.params.name))));

app.put('/api/stacks/:name', wrap(async (req, res) => res.json(await stacks.save(req.params.name, req.body))));

app.post('/api/stacks/:name/actions/:action', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(req, res);
  const write = openStream(res);
  const ok = await stacks.action(req.params.name, req.params.action, write, signal)
    .catch((err) => { write(`Błąd: ${err.message}\n`); return false; });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
}));

app.get('/api/stacks/:name/logs', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(req, res);
  const write = openStream(res);
  await stacks.logs(req.params.name, { tail: req.query.tail, follow: req.query.follow === '1' }, write, signal)
    .catch((err) => write(`Błąd: ${err.message}\n`));
  res.end();
}));

app.delete('/api/stacks/:name', wrap(async (req, res) => {
  if (req.body?.confirm !== req.params.name) {
    return res.status(400).json({ error: 'Wpisz nazwę stacka, aby potwierdzić usunięcie.' });
  }
  const lines = [];
  await stacks.remove(req.params.name, (s) => lines.push(s));
  res.json({ ok: true, output: lines.join('') });
}));

app.get('/api/stacks/:name/operations', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  res.json(stacks.operations(req.params.name));
}));

app.get('/api/operations/:id', (req, res) => {
  const op = stacks.operationOutput(Number(req.params.id));
  if (!op) return res.status(404).json({ error: 'Nie znaleziono.' });
  res.json(op);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Nie znaleziono.' }));

// ---------- interfejs ----------

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err instanceof UserError ? err.status : 500;
  if (status === 500) console.error(err);
  const message = status === 500 ? 'Wewnętrzny błąd panelu – szczegóły w logach kontenera.' : err.message;
  if (res.headersSent) {
    res.end(`\nBłąd: ${message}\n`);
  } else {
    res.status(status).json({ error: message });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`StackPanel działa na http://${config.host}:${config.port}`);
  console.log(`Stacki: ${config.stacksDir}, dane panelu: ${config.dataDir}`);
});
