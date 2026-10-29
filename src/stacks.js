import fs from 'node:fs';
import path from 'node:path';
import { docker, parseJsonLines } from './docker.js';
import { normalizeCompose, addImageVolumes, isFileLikeTarget } from './compose.js';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const ACTIONS = new Set(['up', 'stop', 'restart', 'down', 'update']);

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function parseLsStatus(status = '') {
  let running = 0;
  let total = 0;
  for (const m of String(status).matchAll(/(\w+)\((\d+)\)/g)) {
    const n = Number(m[2]);
    total += n;
    if (m[1] === 'running') running += n;
  }
  const state = total === 0 ? 'down' : running === total ? 'running' : running > 0 ? 'partial' : 'exited';
  return { state, running, total };
}

export function createStacks({ db, stacksDir, getSettings }) {
  const locks = new Set();

  const stackDir = (name) => path.join(stacksDir, name);

  function assertName(name) {
    if (!NAME_RE.test(String(name || ''))) {
      throw new UserError('Nazwa może zawierać tylko małe litery, cyfry, "-" i "_" (np. "nextcloud").');
    }
  }

  function composeFile(name) {
    const dir = stackDir(name);
    for (const f of COMPOSE_FILES) {
      if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    }
    return null;
  }

  function requireStack(name) {
    assertName(name);
    const file = composeFile(name);
    if (!file) throw new UserError('Nie ma takiego stacka.', 404);
    return file;
  }

  function stackRow(name) {
    return db.prepare('SELECT auto_volumes FROM stacks WHERE name = ?').get(name);
  }

  function autoVolumes(name) {
    const row = stackRow(name);
    return row ? row.auto_volumes === 1 : true;
  }

  const base = (name, file) => [
    'compose', '--ansi', 'never', '--progress', 'plain',
    '-p', name, '--project-directory', stackDir(name), '-f', file,
  ];

  // ---------- odczyt ----------

  async function list() {
    let entries = [];
    try {
      entries = fs.readdirSync(stacksDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && NAME_RE.test(e.name))
      .map((e) => e.name)
      .filter((n) => composeFile(n));

    const ls = await docker(['compose', 'ls', '--all', '--format', 'json']);
    const statusByName = new Map(parseJsonLines(ls.stdout).map((p) => [p.Name, p.Status]));

    return names.sort().map((name) => ({
      name,
      ...parseLsStatus(statusByName.get(name)),
      busy: locks.has(name),
    }));
  }

  async function get(name) {
    const file = requireStack(name);
    const envFile = path.join(stackDir(name), '.env');
    const ps = await docker([...base(name, file), 'ps', '--all', '--format', 'json']);
    const containers = parseJsonLines(ps.stdout).map((c) => ({
      name: c.Name,
      service: c.Service,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Publishers
        ? c.Publishers.filter((p) => p.PublishedPort).map((p) => `${p.PublishedPort}→${p.TargetPort}/${p.Protocol}`)
        : [],
    }));
    return {
      name,
      file: path.basename(file),
      compose: fs.readFileSync(file, 'utf8'),
      env: fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '',
      autoVolumes: autoVolumes(name),
      busy: locks.has(name),
      containers,
    };
  }

  // ---------- zapis ----------

  async function validate(name, composeText, envText) {
    const dir = stackDir(name);
    const check = path.join(dir, '.compose.check.yaml');
    const envCheck = path.join(dir, '.env.check');
    fs.writeFileSync(check, composeText);
    fs.writeFileSync(envCheck, envText);
    try {
      const r = await docker([
        'compose', '-p', name, '--project-directory', dir,
        '-f', check, '--env-file', envCheck, 'config', '--quiet',
      ]);
      if (r.code !== 0) {
        const msg = r.output.replaceAll(check, 'compose.yaml').replaceAll(envCheck, '.env').trim();
        throw new UserError(`Docker odrzucił plik compose:\n${msg}`);
      }
    } finally {
      fs.rmSync(check, { force: true });
      fs.rmSync(envCheck, { force: true });
    }
  }

  async function save(name, { compose, env = '', autoVolumes: auto }, { create = false } = {}) {
    assertName(name);
    if (locks.has(name)) throw new UserError('Na tym stacku trwa właśnie operacja.', 409);
    const dir = stackDir(name);
    const existed = fs.existsSync(dir);
    if (create && existed && composeFile(name)) throw new UserError('Stack o tej nazwie już istnieje.', 409);
    if (!create && !composeFile(name)) throw new UserError('Nie ma takiego stacka.', 404);

    const useAuto = auto === undefined ? autoVolumes(name) : Boolean(auto);
    const settings = getSettings();

    let result = { text: String(compose ?? ''), changes: [], warnings: [] };
    if (useAuto) result = normalizeCompose(compose, settings);

    fs.mkdirSync(dir, { recursive: true });
    try {
      await validate(name, result.text, String(env));
    } catch (err) {
      if (create && !existed) fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    const file = composeFile(name) ?? path.join(dir, 'compose.yaml');
    writeAtomic(file, result.text);
    const envFile = path.join(dir, '.env');
    if (String(env).trim() || fs.existsSync(envFile)) writeAtomic(envFile, String(env));

    db.prepare(
      `INSERT INTO stacks(name, auto_volumes) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET auto_volumes = excluded.auto_volumes`
    ).run(name, useAuto ? 1 : 0);

    return { compose: result.text, changes: result.changes, warnings: result.warnings };
  }

  // ---------- przygotowanie przed startem ----------

  async function resolvedConfig(name, file) {
    const r = await docker([...base(name, file), 'config', '--format', 'json']);
    if (r.code !== 0) throw new UserError(`Nie udało się odczytać konfiguracji:\n${r.output.trim()}`);
    return JSON.parse(r.stdout);
  }

  async function imageVolumes(image) {
    const r = await docker(['image', 'inspect', '--format', '{{json .Config.Volumes}}', image]);
    if (r.code !== 0) return null; // obrazu nie ma lokalnie
    try {
      return Object.keys(JSON.parse(r.stdout.trim()) || {});
    } catch {
      return [];
    }
  }

  function mkdirOwned(target, stopAt, uid, gid) {
    // Tworzymy brakujące foldery i nadajemy im właściciela (tylko te nowo utworzone).
    const created = [];
    let p = target;
    while (p.startsWith(stopAt) && p !== stopAt && !fs.existsSync(p)) {
      created.unshift(p);
      p = path.dirname(p);
    }
    for (const dir of created) {
      fs.mkdirSync(dir);
      try { fs.chownSync(dir, uid, gid); } catch { /* panel bez roota – trudno */ }
    }
    return created.length > 0;
  }

  async function prepare(name, log) {
    let file = requireStack(name);
    const dir = stackDir(name);
    const settings = getSettings();

    if (autoVolumes(name)) {
      let cfg = await resolvedConfig(name, file);
      const missing = {};
      for (const [svc, def] of Object.entries(cfg.services || {})) {
        if (!def.image) continue;
        let declared = await imageVolumes(def.image);
        if (declared === null) {
          log(`Pobieram obraz ${def.image}, żeby sprawdzić, gdzie trzyma dane...\n`);
          await docker([...base(name, file), 'pull', svc], { onData: log });
          declared = (await imageVolumes(def.image)) ?? [];
        }
        const covered = new Set((def.volumes || []).map((v) => String(v.target).replace(/\/+$/, '')));
        const todo = declared.filter((t) => !covered.has(t.replace(/\/+$/, '')));
        if (todo.length) missing[svc] = todo;
      }
      if (Object.keys(missing).length) {
        const current = fs.readFileSync(file, 'utf8');
        const res = addImageVolumes(current, missing);
        writeAtomic(file, res.text);
        for (const c of res.changes) log(`[wolumeny] ${c}\n`);
        file = requireStack(name);
      }
    }

    // Tworzymy foldery na dane zanim zrobi to Docker (on założyłby je jako root).
    const cfg = await resolvedConfig(name, file);
    const missingFiles = [];
    for (const [svc, def] of Object.entries(cfg.services || {})) {
      for (const v of def.volumes || []) {
        if (v.type !== 'bind' || !v.source) continue;
        const src = path.resolve(v.source);
        if (!src.startsWith(dir + path.sep)) continue;
        if (fs.existsSync(src)) continue;
        if (isFileLikeTarget(v.target)) {
          missingFiles.push(`${svc}: ${path.relative(dir, src)} (montowany jako ${v.target})`);
          continue;
        }
        if (mkdirOwned(src, dir, settings.puid, settings.pgid)) {
          log(`[wolumeny] utworzono ${path.relative(dir, src)} (właściciel ${settings.puid}:${settings.pgid})\n`);
        }
      }
    }
    if (missingFiles.length) {
      throw new UserError(
        `Brakuje plików konfiguracyjnych, które aplikacja montuje jako pojedyncze pliki:\n` +
        missingFiles.map((f) => `  - ${f}`).join('\n') +
        `\nWgraj je do folderu stacka i uruchom ponownie (Docker utworzyłby w ich miejscu pusty folder).`
      );
    }
    return file;
  }

  // ---------- akcje ----------

  async function action(name, act, write, signal) {
    if (!ACTIONS.has(act)) throw new UserError('Nieznana akcja.');
    let file = requireStack(name);
    if (locks.has(name)) throw new UserError('Na tym stacku trwa już inna operacja.', 409);
    locks.add(name);

    const op = db.prepare(`INSERT INTO operations(stack, action, status) VALUES (?, ?, 'running')`).run(name, act);
    let output = '';
    const log = (s) => {
      output += s;
      if (output.length > 60_000) output = output.slice(-40_000);
      write(s);
    };
    const step = async (args) => {
      log(`$ docker compose ${args.join(' ')}\n`);
      const r = await docker([...base(name, file), ...args], { onData: log, signal });
      if (r.code !== 0) throw new UserError(`Polecenie zakończyło się kodem ${r.code}.`);
    };

    let ok = false;
    try {
      switch (act) {
        case 'up':
          file = await prepare(name, log);
          await step(['up', '-d', '--remove-orphans']);
          break;
        case 'update':
          // Tu w etapie 3 wejdzie automatyczny backup przed aktualizacją.
          await step(['pull']);
          file = await prepare(name, log);
          await step(['up', '-d', '--remove-orphans']);
          break;
        case 'stop':
          await step(['stop']);
          break;
        case 'restart':
          await step(['restart']);
          break;
        case 'down':
          await step(['down', '--remove-orphans']);
          break;
      }
      ok = true;
      log('\nGotowe.\n');
    } catch (err) {
      log(`\nBłąd: ${err.message}\n`);
    } finally {
      db.prepare(`UPDATE operations SET status = ?, output = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(ok ? 'ok' : 'error', output, op.lastInsertRowid);
      locks.delete(name);
    }
    return ok;
  }

  async function logs(name, { tail = 200, follow = false }, write, signal) {
    const file = requireStack(name);
    const t = Math.min(Math.max(parseInt(tail, 10) || 200, 1), 5000);
    const args = [...base(name, file), 'logs', '--no-color', '--timestamps', '--tail', String(t)];
    if (follow) args.push('--follow');
    await docker(args, { onData: write, signal });
  }

  async function remove(name, write) {
    const file = requireStack(name);
    if (locks.has(name)) throw new UserError('Na tym stacku trwa operacja.', 409);
    locks.add(name);
    try {
      write(`$ docker compose down --remove-orphans\n`);
      const r = await docker([...base(name, file), 'down', '--remove-orphans'], { onData: write });
      if (r.code !== 0) throw new UserError('Nie udało się zatrzymać stacka – nic nie usunięto.');
      // Nie kasujemy danych na stałe: folder trafia do kosza.
      const trash = path.join(stacksDir, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trash, `${name}-${stamp}`);
      fs.renameSync(stackDir(name), dest);
      db.prepare('DELETE FROM stacks WHERE name = ?').run(name);
      write(`Folder stacka przeniesiono do ${dest}\n`);
    } finally {
      locks.delete(name);
    }
  }

  function operations(name, limit = 20) {
    return db.prepare(
      `SELECT id, action, status, started_at, finished_at FROM operations
       WHERE stack = ? ORDER BY id DESC LIMIT ?`
    ).all(name, limit);
  }

  function operationOutput(id) {
    return db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
  }

  return { list, get, save, action, logs, remove, operations, operationOutput, assertName };
}
