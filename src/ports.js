// Host port checks done before `docker compose up`, so the user gets a clear message
// ("port 8080 is used by container qbittorrent, 8081 is free") instead of a raw Docker error.

const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]']);
const MAX_RANGE = 1000;

function expandRange(value) {
  const m = String(value ?? '').match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (to < from || to - from > MAX_RANGE) return [from];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Host ports a resolved compose config (`docker compose config --format json`) wants to publish. */
export function publishedPorts(cfg) {
  const out = [];
  for (const [svc, def] of Object.entries(cfg?.services || {})) {
    if (String(def.network_mode || '') === 'host') continue; // no port mapping in host network
    for (const p of def.ports || []) {
      if (p.published === undefined || p.published === null || p.published === '') continue;
      for (const port of expandRange(p.published)) {
        out.push({ svc, port, protocol: p.protocol || 'tcp', hostIp: p.host_ip || '' });
      }
    }
  }
  return out;
}

/** Parses the "Ports" column of `docker ps`, e.g. "0.0.0.0:8080->80/tcp, :::8080->80/tcp". */
export function parsePsPorts(text) {
  const out = [];
  const re = /(?:(\[[^\]]*\]|[\d.]+|:*):)?(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/(tcp|udp|sctp)/g;
  for (const m of String(text || '').matchAll(re)) {
    const ip = (m[1] || '').replace(/^\[|\]$/g, '');
    for (const port of expandRange(m[3] ? `${m[2]}-${m[3]}` : m[2])) {
      out.push({ hostIp: ip === ':' || ip === '::' ? '::' : ip, port, protocol: m[4] });
    }
  }
  return out;
}

function parseLabels(text) {
  const out = {};
  for (const part of String(text || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const overlaps = (a, b) => WILDCARDS.has(a) || WILDCARDS.has(b) || a === b;

/**
 * containers: rows of `docker ps --format '{{json .}}'` (Names, Ports, Labels).
 * Returns conflicts with containers of OTHER projects (this stack's own containers
 * are being recreated, so their ports will be freed).
 */
export function findConflicts(wanted, containers, project) {
  const used = [];
  for (const c of containers) {
    if (parseLabels(c.Labels)['com.docker.compose.project'] === project) continue;
    for (const p of parsePsPorts(c.Ports)) used.push({ ...p, container: c.Names });
  }
  const taken = new Set(used.map((u) => `${u.port}/${u.protocol}`));
  const wantedSet = new Set(wanted.map((w) => `${w.port}/${w.protocol}`));

  const conflicts = [];
  for (const w of wanted) {
    const hit = used.find((u) => u.port === w.port && u.protocol === w.protocol && overlaps(u.hostIp, w.hostIp));
    if (!hit) continue;
    if (conflicts.some((c) => c.port === w.port && c.protocol === w.protocol && c.svc === w.svc)) continue;
    let free = w.port + 1;
    while (free < 65535 && (taken.has(`${free}/${w.protocol}`) || wantedSet.has(`${free}/${w.protocol}`))) free++;
    conflicts.push({ svc: w.svc, port: w.port, protocol: w.protocol, container: hit.container, free });
  }
  return conflicts;
}

/** Port number from Docker's own error when a port is taken (also by a non-Docker program). */
export function portFromDockerError(output) {
  const text = String(output || '');
  const m = text.match(/Bind for [^\s]*:(\d+) failed: port is already allocated/)
    || text.match(/listen (?:tcp|udp)[46]? [^\s]*:(\d+): bind: address already in use/)
    || text.match(/:(\d+): bind: address already in use/);
  return m ? Number(m[1]) : null;
}
