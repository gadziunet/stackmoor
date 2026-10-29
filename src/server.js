import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, getSettings, saveSettings } from './db.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession,
  sessionMiddleware, requireAuth, requireAppHeader, loginRateLimit,
} from './auth.js';
import { createStacks } from './stacks.js';
import { UserError } from './errors.js';
import { i18nMiddleware, translateAll } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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
app.use(i18nMiddleware);
app.use(sessionMiddleware(db));
app.use('/api', requireAppHeader);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
const fail = (req, res, status, key, vars) => res.status(status).json({ error: req.t(key, vars) });

const translateResult = (req, r) => ({
  ...r,
  changes: translateAll(req.t, r.changes),
  warnings: translateAll(req.t, r.warnings),
});

// Strumień tekstowy (wyjście docker compose na żywo).
function openStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (s) => { if (!res.writableEnded) res.write(s); };
}

function abortOnClose(res) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
  return ctl.signal;
}

const errorText = (req, err) => (err instanceof UserError ? req.t(err.key, err.vars) : err.message);

// ---------- konto ----------

app.get('/api/state', (req, res) => {
  res.json({
    needsSetup: !hasUsers(),
    user: req.user ? { username: req.user.username } : null,
    version: pkg.version,
  });
});

app.post('/api/setup', loginRateLimit, (req, res) => {
  if (hasUsers()) return fail(req, res, 409, 'setup.exists');
  const username = String(req.body.username || '').trim();
  const password = req.body.password;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return fail(req, res, 400, 'setup.badUsername');
  const pwErr = validatePassword(password);
  if (pwErr) return fail(req, res, 400, pwErr);
  const r = db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  createSession(db, r.lastInsertRowid, req, res);
  res.json({ ok: true });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return fail(req, res, 401, 'login.invalid');
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
    return fail(req, res, 400, 'password.wrongCurrent');
  }
  const pwErr = validatePassword(req.body.next);
  if (pwErr) return fail(req, res, 400, pwErr);
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
      if (!Number.isInteger(n) || n < 0 || n > 65535) return fail(req, res, 400, 'settings.badId', { key: key.toUpperCase() });
      patch[key] = n;
    }
  }
  if (req.body.hostPathAllowlist !== undefined) {
    const list = Array.isArray(req.body.hostPathAllowlist) ? req.body.hostPathAllowlist : [];
    const clean = list.map((p) => String(p).trim()).filter(Boolean);
    const bad = clean.find((p) => !p.startsWith('/') || p === '/');
    if (bad) return fail(req, res, 400, 'settings.badPath', { path: bad });
    patch.hostPathAllowlist = clean;
  }
  res.json(saveSettings(db, patch));
});

// ---------- stacki ----------

app.get('/api/stacks', wrap(async (_req, res) => res.json(await stacks.list())));

app.post('/api/stacks', wrap(async (req, res) => {
  const result = await stacks.save(req.body.name, req.body, { create: true });
  res.status(201).json(translateResult(req, result));
}));

app.get('/api/stacks/:name', wrap(async (req, res) => res.json(await stacks.get(req.params.name))));

app.put('/api/stacks/:name', wrap(async (req, res) => {
  res.json(translateResult(req, await stacks.save(req.params.name, req.body)));
}));

app.post('/api/stacks/:name/actions/:action', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(res);
  const write = openStream(res);
  const ok = await stacks.action(req.params.name, req.params.action, write, { signal, t: req.t })
    .catch((err) => { write(req.t('log.error', { message: errorText(req, err) }) + '\n'); return false; });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
}));

app.get('/api/stacks/:name/logs', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(res);
  const write = openStream(res);
  await stacks.logs(req.params.name, { tail: req.query.tail, follow: req.query.follow === '1' }, write, signal)
    .catch((err) => write(req.t('log.error', { message: errorText(req, err) }) + '\n'));
  res.end();
}));

app.delete('/api/stacks/:name', wrap(async (req, res) => {
  if (req.body?.confirm !== req.params.name) return fail(req, res, 400, 'delete.confirm');
  const lines = [];
  await stacks.remove(req.params.name, (s) => lines.push(s), req.t);
  res.json({ ok: true, output: lines.join('') });
}));

app.get('/api/stacks/:name/operations', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  res.json(stacks.operations(req.params.name));
}));

app.get('/api/operations/:id', (req, res) => {
  const op = stacks.operationOutput(Number(req.params.id));
  if (!op) return fail(req, res, 404, 'notFound');
  res.json(op);
});

app.use('/api', (req, res) => fail(req, res, 404, 'notFound'));

// ---------- interfejs ----------

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err instanceof UserError ? err.status : 500;
  if (status === 500) console.error(err);
  const message = status === 500 ? req.t('internal') : req.t(err.key, err.vars);
  if (res.headersSent) {
    res.end(`\n${req.t('log.error', { message })}\n`);
  } else {
    res.status(status).json({ error: message });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`StackPanel ${pkg.version} listening on http://${config.host}:${config.port}`);
  console.log(`Stacks: ${config.stacksDir}, panel data: ${config.dataDir}`);
});
