// Automatyczne wolumeny: każdy stack trzyma swoje dane w ./data/ obok compose.yaml.
//
// - wolumen anonimowy (`- /config`)              -> ./data/<serwis>-config:/config
// - ścieżka hosta (`/opt/app:/config`)           -> ./data/<serwis>-config:/config
// - wolumen nazwany (`db_data:/var/lib/mysql`)   -> ./data/db_data:/var/lib/mysql
// - VOLUME z obrazu, nieopisany w compose        -> dopisywany przy uruchomieniu
//
// Nie ruszamy: ścieżek systemowych (docker.sock, /dev, /etc/localtime...),
// ścieżek z listy dozwolonych (np. /mnt, /media), zmiennych ${...},
// ścieżek względnych wewnątrz folderu stacka oraz wolumenów zewnętrznych.

import path from 'node:path';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { UserError } from './errors.js';

export const SYSTEM_PATHS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/etc/localtime',
  '/etc/timezone',
  '/etc/machine-id',
  '/etc/hostname',
  '/etc/ssl/certs',
  '/usr/share/zoneinfo',
  '/dev',
  '/sys',
  '/proc',
  '/lib/modules',
  '/run/udev',
  '/run/dbus',
  '/var/run/dbus',
  '/tmp/.X11-unix',
];

// Rozszerzenia, po których poznajemy, że w kontenerze montowany jest plik, a nie folder.
const FILE_EXT = /\.(ya?ml|json|conf|cfg|cnf|ini|toml|env|txt|xml|js|mjs|php|py|sh|lua|properties|db|sqlite3?|pem|crt|key|html?)$/i;

export function isFileLikeTarget(target) {
  return FILE_EXT.test(String(target || ''));
}

function isUnder(p, base) {
  const b = base.replace(/\/+$/, '');
  return p === b || p.startsWith(b + '/');
}

function slugTarget(target) {
  const s = String(target).replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return s || 'root';
}

function slugName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function dataPathFor(service, target) {
  return `./data/${slugName(service)}-${slugTarget(target)}`;
}

function parseShort(str) {
  const parts = String(str).split(':');
  if (parts.length === 1) return { source: null, target: parts[0], mode: null };
  if (parts.length === 2) return { source: parts[0], target: parts[1], mode: null };
  return { source: parts[0], target: parts[1], mode: parts.slice(2).join(':') };
}

function formatShort(source, target, mode) {
  return `${source}:${target}${mode ? ':' + mode : ''}`;
}

function classify(source) {
  if (source === null || source === undefined || source === '') return 'anonymous';
  if (source.includes('$')) return 'variable';
  if (source.startsWith('/') || source.startsWith('~')) return 'host';
  if (source.startsWith('.')) {
    const norm = path.posix.normalize(source);
    return norm === '..' || norm.startsWith('../') ? 'outside' : 'relative';
  }
  return 'named';
}

export function parseCompose(text) {
  const doc = parseDocument(String(text ?? ''), { keepSourceTokens: false });
  if (doc.errors.length) {
    const e = doc.errors[0];
    throw new UserError('compose.yamlError', { message: e.message });
  }
  const services = doc.get('services');
  if (!isMap(services) || services.items.length === 0) {
    throw new UserError('compose.noServices');
  }
  return doc;
}

function serviceEntries(doc) {
  return doc.get('services').items.map((pair) => ({
    name: String(isScalar(pair.key) ? pair.key.value : pair.key),
    node: pair.value,
  }));
}

/**
 * Przepina wolumeny do folderu stacka.
 * Zwraca { text, changes[], warnings[], changed }; changes/warnings to obiekty { key, vars } do tłumaczenia.
 */
export function normalizeCompose(text, { hostPathAllowlist = [] } = {}) {
  const doc = parseCompose(text);
  const changes = [];
  const warnings = [];

  const topVolumes = doc.get('volumes');
  const convertedNamed = new Set();
  const keptNamed = new Set();

  const namedInfo = (name) => {
    if (!isMap(topVolumes) || !topVolumes.has(name)) return { declared: false, special: false };
    const v = topVolumes.get(name);
    if (!isMap(v)) return { declared: true, special: false };
    const external = v.get('external');
    const special = Boolean(external) || v.has('driver') || v.has('driver_opts');
    return { declared: true, special };
  };

  // Decyzja dla pojedynczego montowania; zwraca nowe źródło albo null (bez zmian).
  const decide = (svc, source, target) => {
    const kind = classify(source);
    const label = source ? `${source}:${target}` : target;

    switch (kind) {
      case 'anonymous':
        return dataPathFor(svc, target);
      case 'relative':
        return null;
      case 'variable':
        warnings.push({ key: 'warn.variable', vars: { svc, label } });
        return null;
      case 'named': {
        const info = namedInfo(source);
        if (info.special) {
          keptNamed.add(source);
          warnings.push({ key: 'warn.external', vars: { svc, name: source } });
          return null;
        }
        convertedNamed.add(source);
        return `./data/${slugName(source)}`;
      }
      case 'host':
      case 'outside': {
        if (kind === 'host' && SYSTEM_PATHS.some((p) => isUnder(source, p))) return null;
        if (kind === 'host' && hostPathAllowlist.some((p) => isUnder(source, p))) {
          warnings.push({ key: 'warn.allowlisted', vars: { svc, source } });
          return null;
        }
        const next = dataPathFor(svc, target);
        warnings.push({ key: 'warn.moveData', vars: { svc, source, dest: next } });
        return next;
      }
      default:
        return null;
    }
  };

  for (const { name: svc, node } of serviceEntries(doc)) {
    if (!isMap(node)) continue;
    const vols = node.get('volumes');
    if (!isSeq(vols)) continue;

    for (const item of vols.items) {
      // Składnia krótka: "źródło:cel[:tryb]"
      if (isScalar(item) && typeof item.value === 'string') {
        const { source, target, mode } = parseShort(item.value);
        const next = decide(svc, source, target);
        if (next) {
          const before = item.value;
          item.value = formatShort(next, target, mode);
          changes.push({ key: 'change.rewrite', vars: { svc, from: before, to: item.value } });
        }
        continue;
      }
      // Składnia długa: { type, source, target, ... }
      if (isMap(item)) {
        const type = item.get('type') ?? 'volume';
        if (type !== 'bind' && type !== 'volume') continue; // tmpfs, npipe, cluster...
        const target = item.get('target');
        const source = item.get('source') ?? null;
        const next = decide(svc, source, target);
        if (next) {
          const before = source ? `${source}:${target}` : String(target);
          item.set('type', 'bind');
          item.set('source', next);
          item.delete('volume'); // opcje typu "volume: nocopy" nie pasują do bind
          changes.push({ key: 'change.rewrite', vars: { svc, from: before, to: `${next}:${target}` } });
        }
      }
    }
  }

  // Usuwamy z sekcji "volumes" wolumeny, które zamieniliśmy na foldery.
  if (isMap(topVolumes)) {
    for (const name of convertedNamed) {
      if (!keptNamed.has(name) && topVolumes.has(name)) topVolumes.delete(name);
    }
    if (topVolumes.items.length === 0) doc.delete('volumes');
  }

  const out = changes.length ? doc.toString({ lineWidth: 0 }) : String(text);
  return { text: out, changes, warnings, changed: changes.length > 0 };
}

/**
 * Dopisuje montowania dla ścieżek z instrukcji VOLUME w obrazie,
 * których compose nie opisuje. missing = { serwis: ['/data', ...] }.
 */
export function addImageVolumes(text, missing) {
  const doc = parseCompose(text);
  const changes = [];
  for (const { name: svc, node } of serviceEntries(doc)) {
    const paths = missing[svc];
    if (!paths?.length || !isMap(node)) continue;
    let vols = node.get('volumes');
    if (!isSeq(vols)) {
      node.set('volumes', doc.createNode([]));
      vols = node.get('volumes');
    }
    for (const target of paths) {
      const entry = `${dataPathFor(svc, target)}:${target}`;
      vols.add(doc.createNode(entry));
      changes.push({ key: 'change.image', vars: { svc, target, entry } });
    }
  }
  return { text: changes.length ? doc.toString({ lineWidth: 0 }) : String(text), changes };
}
