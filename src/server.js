import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, getSettings, saveSettings, getState, setState } from './db.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, destroySession,
  sessionMiddleware, requireAuth, requireAppHeader, loginRateLimit,
} from './auth.js';
import { createStacks } from './stacks.js';
import { UserError } from './errors.js';
import { i18nMiddleware, translateAll, translate } from './i18n.js';
import { stacksDirMounted } from './mounts.js';
import { createUpdates } from './updates.js';
import { VERSION } from './version.js';
import { initSecrets } from './secrets.js';
import { createDomains } from './domains.js';
import { createPanelLock } from './panel-lock.js';
import { createBackups } from './backups.js';

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
initSecrets(config.dataDir);
const stacksDirOk = stacksDirMounted(config.stacksDir);
if (!stacksDirOk) {
  console.warn(`WARNING: ${config.stacksDir} is not mounted from the host – mount it at the same path and set STACKS_DIR.`);
}
const stacks = createStacks({ db, stacksDir: config.stacksDir, getSettings: () => getSettings(db) });
const updates = createUpdates({ db, stacks, getSettings: () => getSettings(db) });
updates.startScheduler();
// Language for things that run on their own (scheduled backups): the one the admin last used.
let lastLang = getState(db, 'ui.lang', 'en');
const backups = createBackups({ db, stacks, stacksDir: config.stacksDir, dataDir: config.dataDir, sqlite: db });
backups.startScheduler(() => (key, vars) => translate(lastLang, key, vars));
const domains = createDomains({
  db, stacks, stacksDir: config.stacksDir,
  getSettings: () => getSettings(db),
  saveSettings: (patch) => saveSettings(db, patch),
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));
app.use(i18nMiddleware);

// ---------- panel only through its domain ----------
domains.attachSelf().catch(() => {}).then(() => domains.refreshCaddyIp()).catch(() => {});
// After restoring a whole server: start Caddy with the restored domain settings.
backups.hooks.afterServerRestore = async (log, t) => {
  if (!getSettings(db).domain) return;
  await domains.attachSelf().catch(() => {});
  await domains.apply(log, t);
};
const panelLock = createPanelLock({ getSettings: () => getSettings(db), domains });
setInterval(() => { if (panelLock.lockedHost()) domains.refreshCaddyIp().catch(() => {}); }, 60_000).unref();
app.use(panelLock.middleware);

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

// Plain-text stream (live docker compose output).
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

// ---------- account ----------

app.get('/api/state', (req, res) => {
  res.json({
    needsSetup: !hasUsers(),
    restoring: Boolean(backups.serverRestoreStatus() && !backups.serverRestoreStatus().done),
    user: req.user ? { username: req.user.username } : null,
    version: VERSION,
    ...(req.user ? { stacksDir: config.stacksDir, stacksDirOk: stacksDirOk } : {}),
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

// ---------- setup wizard: restore a whole server from a backup ----------
// Open only while the panel has no account yet; the status stays readable while a restore runs.

const setupOnly = (req, res, next) => (hasUsers() ? fail(req, res, 409, 'setup.exists') : next());

app.get('/api/setup/restore/options', setupOnly, (_req, res) => {
  res.json({ destinations: backups.publicConfig().destinations });
});

app.post('/api/setup/restore/connect', loginRateLimit, setupOnly, wrap(async (req, res) => {
  res.json({ runs: await backups.connectExisting(req.body || {}) });
}));

app.post('/api/setup/restore/start', setupOnly, wrap(async (req, res) => {
  res.status(202).json(await backups.restoreServer(String(req.body?.run || ''), req.t));
}));

app.get('/api/setup/restore/status', (req, res) => {
  const st = backups.serverRestoreStatus();
  if (!st) return fail(req, res, 404, 'notFound');
  res.json(st);
});

app.use('/api', requireAuth);
app.use('/api', (req, _res, next) => {
  if (req.lang !== lastLang) { lastLang = req.lang; setState(db, 'ui.lang', lastLang); }
  next();
});

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

// ---------- settings ----------

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
  for (const key of ['updateCheck', 'updateCheckStacks']) {
    if (req.body[key] !== undefined) patch[key] = Boolean(req.body[key]);
  }
  if (req.body.updateInterval !== undefined) {
    patch.updateInterval = req.body.updateInterval === 'weekly' ? 'weekly' : 'daily';
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

// ---------- stacks ----------

app.get('/api/stacks', wrap(async (_req, res) => {
  const withUpdates = new Set(updates.status().stacksWithUpdates);
  res.json((await stacks.list()).map((s) => ({ ...s, updateAvailable: withUpdates.has(s.name) })));
}));

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
  // After updating images, refresh this stack's "update available" flag in the background.
  if (ok && (req.params.action === 'update' || req.params.action === 'up')) {
    updates.checkStack(req.params.name).catch(() => {});
  }
}));

// ---------- updates ----------

app.get('/api/updates', wrap(async (_req, res) => {
  res.json({ ...updates.status(), self: await updates.selfInfo().then((s) => ({ mode: s.mode, tag: s.tag })) });
}));

app.post('/api/updates/check', wrap(async (_req, res) => {
  await updates.checkAll();
  res.json({ ...updates.status(), self: await updates.selfInfo().then((s) => ({ mode: s.mode, tag: s.tag })) });
}));

app.post('/api/updates/apply', wrap(async (_req, res) => {
  res.json(await updates.updatePanel());
}));

app.get('/api/stacks/:name/logs', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(res);
  const write = openStream(res);
  await stacks.logs(req.params.name, { tail: req.query.tail, follow: req.query.follow === '1', service: String(req.query.service || '') }, write, signal)
    .catch((err) => write(req.t('log.error', { message: errorText(req, err) }) + '\n'));
  res.end();
}));

app.delete('/api/stacks/:name', wrap(async (req, res) => {
  if (req.body?.confirm !== req.params.name) return fail(req, res, 400, 'delete.confirm');
  const lines = [];
  await stacks.remove(req.params.name, (s) => lines.push(s), req.t);
  if (domains.routes(req.params.name).length) {
    domains.removeStack(req.params.name);
    if (getSettings(db).domain) await domains.apply(() => {}, req.t).catch(() => {});
  }
  res.json({ ok: true, output: lines.join('') });
}));

// ---------- backups ----------

// Long jobs run in the background; the UI polls /api/backups/status.
const background = (p) => { p.catch(() => {}); };

app.get('/api/backups', wrap(async (_req, res) => {
  res.json({ config: backups.publicConfig(), status: backups.status() });
}));

app.put('/api/backups', wrap(async (req, res) => res.json(backups.saveConfig(req.body || {}))));

app.post('/api/backups/test', wrap(async (_req, res) => res.json(await backups.test())));

app.post('/api/backups/reveal', (_req, res) => res.json({ password: backups.revealPassword() }));

app.get('/api/backups/status', (_req, res) => res.json(backups.status()));

app.get('/api/backups/snapshots', wrap(async (req, res) => {
  const list = await backups.snapshots({ fresh: req.query.fresh === '1' });
  res.json(req.query.stack ? list.filter((s) => s.stack === req.query.stack) : list);
}));

app.post('/api/backups/run', (req, res) => {
  background(backups.runAll('manual', req.t));
  res.status(202).json({ ok: true });
});

app.post('/api/backups/verify', (req, res) => {
  background(backups.verifyNow(req.t));
  res.status(202).json({ ok: true });
});

app.post('/api/stacks/:name/backup', (req, res) => {
  stacks.assertName(req.params.name);
  background(backups.backupOne(req.params.name, req.t));
  res.status(202).json({ ok: true });
});

app.get('/api/backups/runs', wrap(async (req, res) => {
  res.json(await backups.runs({ fresh: req.query.fresh === '1' }));
}));

app.post('/api/backups/restore-run', wrap(async (req, res) => {
  if (req.body?.confirm !== true) return fail(req, res, 400, 'delete.confirm');
  background(backups.restoreRun(String(req.body.run || ''), req.t));
  res.status(202).json({ ok: true });
}));

app.post('/api/backups/restore', wrap(async (req, res) => {
  const target = String(req.body?.target || '');
  if (!target || req.body?.confirm !== target) return fail(req, res, 400, 'delete.confirm');
  stacks.assertName(target);
  background(backups.restore(String(req.body.snapshot || ''), target, req.t));
  res.status(202).json({ ok: true });
}));

// ---------- domains ----------

app.get('/api/domains', wrap(async (_req, res) => {
  res.json({ ...domains.publicConfig(), status: await domains.status() });
}));

app.put('/api/domains', wrap(async (req, res) => {
  domains.saveConfig(req.body || {}, req.hostname);
  res.json(domains.publicConfig());
}));

app.put('/api/domains/panel', wrap(async (req, res) => {
  await domains.savePanel(req.body || {}, req.hostname);
  res.json(domains.publicConfig());
}));

app.post('/api/domains/update-caddy', wrap(async (req, res) => {
  const write = openStream(res);
  let ok = true;
  await domains.updateCaddy(write, req.t).catch((err) => {
    ok = false;
    write(`\n${req.t('log.error', { message: errorText(req, err) })}\n`);
  });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
  updates.checkCaddy().catch(() => {});
}));

app.post('/api/domains/apply', wrap(async (req, res) => {
  const write = openStream(res);
  let ok = true;
  await domains.apply(write, req.t).catch((err) => {
    ok = false;
    write(`\n${req.t('log.error', { message: errorText(req, err) })}\n`);
  });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
}));

app.get('/api/domains/status', wrap(async (_req, res) => res.json(await domains.status())));

app.get('/api/stacks/:name/routes', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const cfg = await stacks.config(req.params.name);
  const services = Object.entries(cfg.services || {}).map(([name, def]) => ({
    name,
    ports: [...new Set([
      ...(def.ports || []).map((p) => Number(p.target)),
      ...(def.expose || []).map((p) => Number(String(p).split('/')[0])),
    ].filter(Boolean))],
    hostNetwork: Boolean(def.network_mode),
  }));
  const s = getSettings(db);
  res.json({ domain: s.domain, routes: domains.routes(req.params.name), services });
}));

app.put('/api/stacks/:name/routes', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  await domains.setRoutes(req.params.name, req.body?.routes);
  let log = '';
  let applied = true;
  if (getSettings(db).domain) {
    await domains.apply((s) => { log += s; }, req.t).catch((err) => {
      applied = false;
      log += `\n${req.t('log.error', { message: errorText(req, err) })}\n`;
    });
  }
  res.json({ routes: domains.routes(req.params.name), applied, log });
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

// ---------- UI ----------

const publicDir = path.join(__dirname, '..', 'public');
// No caching without asking: after an update the browser must not keep the old UI.
// (ETags keep it cheap – an unchanged file is answered with 304.)
app.use(express.static(publicDir, { index: 'index.html', maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
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
  console.log(`Stackmoor ${VERSION} listening on http://${config.host}:${config.port}`);
  console.log(`Stacks: ${config.stacksDir}, panel data: ${config.dataDir}`);
});
