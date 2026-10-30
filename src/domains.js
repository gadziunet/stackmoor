import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { docker, parseJsonLines } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt, mask } from './secrets.js';
import { PROVIDERS, providerById, providerJson } from './dns-providers.js';
import { publishedPorts, findConflicts } from './ports.js';
import { certErrors } from './caddy-logs.js';
import { VERSION, isSemver } from './version.js';

// Local domains: one Caddy container ("stackmoor-caddy") in front of all stacks.
// - It holds one wildcard certificate (*.domain) obtained through the DNS provider's API,
//   so the server never has to be reachable from the internet.
// - Stacks with a domain join the shared "stackmoor" network (via compose.stackmoor.yaml),
//   and Caddy proxies <sub>.<domain> to "<container>:<port>".
// - Config is JSON written to disk and loaded with `caddy reload` – no admin port exposed.

export const NETWORK = 'stackmoor';
const CADDY = 'stackmoor-caddy';
const OVERRIDE = 'compose.stackmoor.yaml';
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const writeFile = (file, content, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
};

/**
 * Caddy goes with the panel: a release uses the Caddy image built for the same tag
 * (panel 0.6.1 → stackmoor-caddy:0.6.1), edge uses :edge. Updating the panel is all it takes.
 */
export function caddyImageFor(version = VERSION, fromCi = Boolean(process.env.APP_VERSION)) {
  const tag = version === 'edge' ? 'edge' : (fromCi && isSemver(version) ? String(version).replace(/^v/, '') : 'latest');
  return `ghcr.io/gadziunet/stackmoor-caddy:${tag}`;
}

/** The panel's own address under a newly added domain, like Cloudron's my.<domain>. */
export const DEFAULT_PANEL_SUBDOMAIN = 'my';

export function createDomains({ db, stacks, stacksDir, getSettings, saveSettings }) {
  const caddyDir = path.join(stacksDir, '.stackmoor', 'caddy');
  const image = process.env.STACKMOOR_CADDY_IMAGE || caddyImageFor();
  const followsTag = image.endsWith(':edge') || image.endsWith(':latest'); // moving tags: pull to see changes
  const panelPort = Number(process.env.PORT || 5001);

  // ---------- credentials ----------

  function credentials() {
    return decrypt(getState(db, 'dns.credentials')) || {};
  }

  /** Provider fields for the UI, with saved secrets masked. */
  function publicConfig() {
    const s = getSettings();
    const creds = credentials();
    const masked = {};
    const p = providerById(s.dnsProvider);
    for (const f of p?.fields || []) {
      const v = creds[f.key];
      masked[f.key] = f.secret ? mask(v) : v || '';
    }
    return {
      domain: s.domain,
      dnsProvider: s.dnsProvider,
      acmeEmail: s.acmeEmail,
      httpPort: s.httpPort,
      httpsPort: s.httpsPort,
      panelSubdomain: s.panelSubdomain,
      panelDomainOnly: Boolean(s.panelDomainOnly && s.domain && s.panelSubdomain),
      panelUrl: panelUrl(s),
      credentials: masked,
      providers: PROVIDERS.map(({ id, name, fields, help }) => ({ id, name, fields, help })),
    };
  }

  function panelUrl(s = getSettings()) {
    if (!s.domain || !s.panelSubdomain) return '';
    return `https://${s.panelSubdomain}.${s.domain}${s.httpsPort === 443 ? '' : `:${s.httpsPort}`}`;
  }

  /**
   * @param body  settings from the UI
   * @param currentHost  the host the user opened the panel with – the IP lock may only be
   *   turned on from the panel's own address, which proves that address works.
   */
  function saveConfig(body, currentHost = '') {
    const saved = getSettings();
    const domain = String(body.domain ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (domain && !DOMAIN_RE.test(domain)) throw new UserError('dns.badDomain', { domain });

    const provider = String(body.dnsProvider || '');
    if (domain && provider !== 'internal' && !providerById(provider)) throw new UserError('dns.badProvider');

    // The panel address has its own section; the main form leaves it as it is.
    let panelSubdomain = String(body.panelSubdomain ?? saved.panelSubdomain ?? '').trim().toLowerCase();
    // First domain: give the panel my.<domain> right away (it can be changed or cleared later).
    if (domain && !saved.domain && !panelSubdomain && body.panelSubdomain === undefined
      && !db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(DEFAULT_PANEL_SUBDOMAIN)) {
      panelSubdomain = DEFAULT_PANEL_SUBDOMAIN;
    }
    if (panelSubdomain && !SUBDOMAIN_RE.test(panelSubdomain)) throw new UserError('dns.badSubdomain', { sub: panelSubdomain });
    if (panelSubdomain && db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(panelSubdomain)) {
      throw new UserError('dns.subdomainTaken', { sub: panelSubdomain });
    }

    const port = (v, def) => {
      const n = Number(v ?? def);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UserError('dns.badPort');
      return n;
    };
    const httpPort = port(body.httpPort, 80);
    const httpsPort = port(body.httpsPort, 443);
    if (httpPort === httpsPort) throw new UserError('dns.badPort');

    const email = String(body.acmeEmail ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('dns.badEmail');

    // Credentials: empty secret fields keep the saved value (the UI only shows a mask).
    const p = providerById(provider);
    const old = credentials();
    const next = {};
    for (const f of p?.fields || []) {
      let v = String(body.credentials?.[f.key] ?? '').trim();
      if (f.secret && (v === '' || v.startsWith('••••••'))) v = old[f.key] || '';
      if (/[\n\r]/.test(v)) throw new UserError('dns.badValue', { field: f.label });
      if (!v && f.default !== undefined) v = f.default;
      if (domain && f.required && !v) throw new UserError('dns.missingField', { field: f.label });
      if (v) next[f.key] = v;
    }
    setState(db, 'dns.credentials', encrypt(next));
    const panelDomainOnly = Boolean(body.panelDomainOnly ?? saved.panelDomainOnly) && Boolean(domain && panelSubdomain);
    if (panelDomainOnly && String(currentHost).toLowerCase() !== `${panelSubdomain}.${domain}`) {
      throw new UserError('dns.lockNeedsDomain', { url: `https://${panelSubdomain}.${domain}` });
    }
    saveSettings({ domain, dnsProvider: provider, acmeEmail: email, httpPort, httpsPort, panelSubdomain, panelDomainOnly });
  }

  /** Panel address and IP lock only – needs just a config reload, not a Caddy restart. */
  async function savePanel(body, currentHost = '') {
    const s = getSettings();
    if (!s.domain) throw new UserError('dns.noDomain');
    const panelSubdomain = String(body.panelSubdomain ?? '').trim().toLowerCase();
    if (panelSubdomain && !SUBDOMAIN_RE.test(panelSubdomain)) throw new UserError('dns.badSubdomain', { sub: panelSubdomain });
    if (panelSubdomain && db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(panelSubdomain)) {
      throw new UserError('dns.subdomainTaken', { sub: panelSubdomain });
    }
    const panelDomainOnly = Boolean(body.panelDomainOnly) && Boolean(panelSubdomain);
    if (panelDomainOnly && String(currentHost).toLowerCase() !== `${panelSubdomain}.${s.domain}`) {
      throw new UserError('dns.lockNeedsDomain', { url: `https://${panelSubdomain}.${s.domain}` });
    }
    saveSettings({ panelSubdomain, panelDomainOnly });
    await reloadConfig();
  }

  /** Rewrites caddy.json and reloads it in the running container (no pull, no restart). */
  async function reloadConfig() {
    writeFile(path.join(caddyDir, 'config', 'caddy.json'), JSON.stringify(await buildConfig(), null, 2), 0o600);
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', CADDY]);
    if (ps.code !== 0 || ps.stdout.trim() !== 'running') return false;
    const r = await docker(['exec', CADDY, 'caddy', 'reload', '--config', '/etc/caddy/caddy.json']);
    if (r.code !== 0) throw new UserError('dns.reloadFailed');
    await refreshCaddyIp();
    return true;
  }

  // ---------- routes ----------

  function routes(stack) {
    return stack
      ? db.prepare('SELECT subdomain, service, port FROM routes WHERE stack = ? ORDER BY subdomain').all(stack)
      : db.prepare('SELECT stack, subdomain, service, port FROM routes ORDER BY subdomain').all();
  }

  async function setRoutes(stack, list) {
    const cfg = await stacks.config(stack);
    const services = Object.keys(cfg.services || {});
    const s = getSettings();
    const clean = [];
    const seen = new Set();
    for (const r of Array.isArray(list) ? list : []) {
      const subdomain = String(r.subdomain || '').trim().toLowerCase();
      const service = String(r.service || '');
      const port = Number(r.port);
      if (!SUBDOMAIN_RE.test(subdomain)) throw new UserError('dns.badSubdomain', { sub: subdomain });
      if (seen.has(subdomain) || subdomain === s.panelSubdomain) throw new UserError('dns.subdomainTaken', { sub: subdomain });
      const other = db.prepare('SELECT stack FROM routes WHERE subdomain = ? AND stack != ?').get(subdomain, stack);
      if (other) throw new UserError('dns.subdomainTaken', { sub: subdomain });
      if (!services.includes(service)) throw new UserError('dns.badService', { service });
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('dns.badPort');
      seen.add(subdomain);
      clean.push({ subdomain, service, port });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM routes WHERE stack = ?').run(stack);
      const ins = db.prepare('INSERT INTO routes(stack, subdomain, service, port) VALUES (?, ?, ?, ?)');
      for (const r of clean) ins.run(stack, r.subdomain, r.service, r.port);
    })();
    await writeOverride(stack);
  }

  function removeStack(stack) {
    db.prepare('DELETE FROM routes WHERE stack = ?').run(stack);
  }

  /** compose.stackmoor.yaml: adds the routed services to the shared network (keeping their own). */
  async function writeOverride(stack) {
    const file = path.join(stacks.stackDir(stack), OVERRIDE);
    const list = routes(stack);
    if (!list.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    // Read the config without the old override so we see the user's own networks.
    fs.rmSync(file, { force: true });
    const cfg = await stacks.config(stack);
    const services = {};
    for (const svc of new Set(list.map((r) => r.service))) {
      const def = cfg.services?.[svc];
      if (!def || def.network_mode) continue; // host network etc. – reached via host.docker.internal
      const own = Object.keys(def.networks || { default: null });
      services[svc] = { networks: Object.fromEntries([...own, NETWORK].map((n) => [n, {}])) };
    }
    if (!Object.keys(services).length) return;
    const doc = {
      services,
      networks: { [NETWORK]: { external: true, name: NETWORK } },
    };
    writeFile(file, `# Generated by Stackmoor for local domains – do not edit, changes are overwritten.\n${stringify(doc)}`);
  }

  /** Where Caddy should send traffic for a route. */
  function upstream(stack, route, cfg) {
    const def = cfg.services?.[route.service] || {};
    if (def.network_mode) return `host.docker.internal:${route.port}`;
    const container = def.container_name || `${stack}-${route.service}-1`;
    return `${container}:${route.port}`;
  }

  // ---------- Caddy ----------

  async function selfContainer() {
    const r = await docker(['inspect', '--format', '{{.Name}}', os.hostname()]);
    return r.code === 0 ? r.stdout.trim().replace(/^\//, '') : null;
  }

  async function buildConfig() {
    const s = getSettings();
    const hostRoutes = [];
    for (const r of routes()) {
      let cfg;
      try { cfg = await stacks.config(r.stack); } catch { continue; }
      hostRoutes.push({ host: `${r.subdomain}.${s.domain}`, dial: upstream(r.stack, r, cfg) });
    }
    if (s.panelSubdomain) {
      const self = await selfContainer();
      hostRoutes.push({
        host: `${s.panelSubdomain}.${s.domain}`,
        dial: self ? `${self}:${panelPort}` : `host.docker.internal:${panelPort}`,
      });
    }

    const issuer = s.dnsProvider === 'internal'
      ? { module: 'internal' }
      : {
        module: 'acme',
        ...(s.acmeEmail ? { email: s.acmeEmail } : {}),
        challenges: {
          dns: {
            provider: providerJson(s.dnsProvider, credentials()),
            ...(providerById(s.dnsProvider)?.propagationDelay ? { propagation_delay: providerById(s.dnsProvider).propagationDelay } : {}),
          },
        },
      };

    return {
      admin: { listen: 'localhost:2019' },
      logging: { logs: { default: { level: 'INFO' } } },
      apps: {
        http: {
          http_port: 80,
          https_port: 443,
          servers: {
            stackmoor: {
              listen: [':443'],
              routes: hostRoutes.map((r) => ({
                match: [{ host: [r.host] }],
                handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: r.dial }] }],
                terminal: true,
              })),
            },
          },
        },
        // One wildcard certificate covers every app: Caddy skips per-host certificates
        // for names covered by a managed wildcard (default since Caddy 2.10).
        tls: {
          certificates: { automate: [`*.${s.domain}`] },
          automation: { policies: [{ subjects: [`*.${s.domain}`], issuers: [issuer] }] },
        },
      },
    };
  }

  function caddyCompose(s) {
    return {
      name: CADDY,
      services: {
        caddy: {
          image,
          container_name: CADDY,
          restart: 'unless-stopped',
          command: ['caddy', 'run', '--config', '/etc/caddy/caddy.json'],
          ports: [`${s.httpPort}:80`, `${s.httpsPort}:443`, `${s.httpsPort}:443/udp`],
          volumes: ['./config:/etc/caddy', './data:/data', './runtime:/config'],
          extra_hosts: ['host.docker.internal:host-gateway'],
          networks: [NETWORK],
        },
      },
      networks: { [NETWORK]: { external: true, name: NETWORK } },
    };
  }

  const composeArgs = () => ['compose', '--ansi', 'never', '--progress', 'plain', '-p', CADDY,
    '--project-directory', caddyDir, '-f', path.join(caddyDir, 'compose.yaml')];

  async function ensureNetwork() {
    const r = await docker(['network', 'inspect', NETWORK]);
    if (r.code !== 0) await docker(['network', 'create', NETWORK]);
  }

  /** Writes Caddy's files, (re)starts it and reloads the config. Streams output through log(). */
  async function apply(log, t) {
    const s = getSettings();
    if (!s.domain) {
      log(t('dns.log.disabled') + '\n');
      await docker([...composeArgs(), 'down'], { onData: log });
      return;
    }
    if (!s.dnsProvider) throw new UserError('dns.badProvider');

    await ensureNetwork();
    writeFile(path.join(caddyDir, 'compose.yaml'), stringify(caddyCompose(s)));
    // The JSON holds the DNS API key, so only root may read it.
    writeFile(path.join(caddyDir, 'config', 'caddy.json'), JSON.stringify(await buildConfig(), null, 2), 0o600);

    // Free ports? (other containers; Caddy's own container is ignored)
    const cfg = await docker([...composeArgs(), 'config', '--format', 'json']);
    if (cfg.code === 0) {
      const ps = await docker(['ps', '--format', '{{json .}}']);
      const conflicts = findConflicts(publishedPorts(JSON.parse(cfg.stdout)), parseJsonLines(ps.stdout), CADDY);
      if (conflicts.length) throw new UserError('ports.conflicts', { conflicts });
    }

    // Connect the panel and running routed containers to the shared network.
    const self = await selfContainer();
    if (self) await docker(['network', 'connect', NETWORK, self]);
    for (const r of routes()) {
      try {
        const c = await stacks.config(r.stack);
        const def = c.services?.[r.service] || {};
        if (!def.network_mode) await docker(['network', 'connect', NETWORK, def.container_name || `${r.stack}-${r.service}-1`]);
      } catch { /* stack not running or broken – it joins on next start */ }
    }

    log(`$ docker compose -p ${CADDY} up -d\n`);
    // Pull only when the image is not here yet – saving settings should not download anything.
    if ((await docker(['image', 'inspect', image])).code !== 0) {
      const pull = await docker([...composeArgs(), 'pull', '--quiet'], { onData: log });
      if (pull.code !== 0) log(t('dns.log.pullFailed') + '\n');
    }
    const before = await containerId();
    const r = await docker([...composeArgs(), 'up', '-d', '--remove-orphans'], { onData: log });
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });

    // A freshly (re)created container has just read the config – reloading it right away
    // would cancel the certificate request it started. Otherwise reload; without --force
    // Caddy ignores an unchanged config, so a running certificate request keeps going.
    if (before && before === await containerId()) {
      const reload = await docker(['exec', CADDY, 'caddy', 'reload', '--config', '/etc/caddy/caddy.json'], { onData: log });
      if (reload.code !== 0) throw new UserError('dns.reloadFailed');
    }
    refreshCaddyIp();
    log(t('dns.log.applied') + '\n');
  }

  /** On start: a recreated panel container (e.g. after an update) has left the shared network. */
  async function attachSelf() {
    if (!getSettings().domain) return;
    const self = await selfContainer();
    if (!self) return;
    await ensureNetwork();
    const r = await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', self]);
    if (r.code === 0 && !(NETWORK in (JSON.parse(r.stdout || '{}') || {}))) {
      await docker(['network', 'connect', NETWORK, self]);
    }
  }

  async function containerId() {
    const r = await docker(['inspect', '--format', '{{.Id}}', CADDY]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  // Caddy's address on the shared network: with the IP lock on, only it may talk to the panel.
  let caddyIp = null;
  // Only when the panel itself runs in a container on that network (otherwise Caddy reaches it
  // through host.docker.internal and the Host header is all we can check).
  async function refreshCaddyIp() {
    if (!await selfContainer()) { caddyIp = null; return null; }
    const r = await docker(['inspect', '--format', `{{with index .NetworkSettings.Networks "${NETWORK}"}}{{.IPAddress}}{{end}}`, CADDY]);
    caddyIp = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    return caddyIp;
  }

  /**
   * After a panel update: switch Caddy to the image that belongs to this panel version.
   * Runs on start and every few hours (the Caddy image of a release may be published a bit
   * after the panel's). If the image can't be pulled, the old Caddy keeps running.
   */
  async function syncImage() {
    const s = getSettings();
    if (!s.domain || !fs.existsSync(path.join(caddyDir, 'compose.yaml'))) return { changed: false };
    const local = () => docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    let want = await local();
    if (followsTag || want.code !== 0) {
      const pull = await docker(['pull', '--quiet', image]);
      if (pull.code !== 0 && want.code !== 0) {
        setState(db, 'caddy.image', { image, ok: false, at: new Date().toISOString() });
        return { changed: false, error: 'pull' };
      }
      want = await local();
    }
    const cur = await docker(['inspect', '--format', '{{.Image}}', CADDY]);
    if (cur.code === 0 && cur.stdout.trim() === want.stdout.trim()) {
      setState(db, 'caddy.image', { image, ok: true, at: new Date().toISOString() });
      return { changed: false };
    }
    // Certificates live in ./data, so recreating the container keeps them.
    writeFile(path.join(caddyDir, 'compose.yaml'), stringify(caddyCompose(s)));
    const up = await docker([...composeArgs(), 'up', '-d', '--remove-orphans']);
    setState(db, 'caddy.image', { image, ok: up.code === 0, at: new Date().toISOString() });
    if (up.code !== 0) return { changed: false, error: 'up' };
    await refreshCaddyIp();
    return { changed: true };
  }

  /** Is Caddy running, is there a certificate, and the latest certificate errors. */
  async function status() {
    const s = getSettings();
    if (!s.domain) return { enabled: false };
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', CADDY]);
    const running = ps.code === 0 && ps.stdout.trim() === 'running';
    let certificate = false;
    let errors = [];
    if (running) {
      const ls = await docker(['exec', CADDY, 'sh', '-c', 'ls -1 /data/caddy/certificates/*/ 2>/dev/null']);
      certificate = ls.stdout.split('\n').some((d) => d.trim() === `wildcard_.${s.domain}`);
      const logs = await docker(['logs', '--since', '24h', '--tail', '500', CADDY]);
      errors = certErrors(logs.output);
    }
    const img = getState(db, 'caddy.image');
    const imageProblem = img && !img.ok && img.image === image ? image : null;
    return { enabled: true, running, certificate, errors, domain: s.domain, panelUrl: panelUrl(s), imageProblem };
  }

  return {
    publicConfig, saveConfig, routes, setRoutes, removeStack, writeOverride, apply, status, buildConfig,
    panelUrl, refreshCaddyIp, attachSelf, savePanel, reloadConfig, syncImage, caddyIp: () => caddyIp,
  };
}
