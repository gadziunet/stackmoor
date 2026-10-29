import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { normalizeCompose, addImageVolumes, isFileLikeTarget } from '../src/compose.js';

const vols = (text, svc) => parse(text).services[svc].volumes;

test('anonymous volume goes to ./data', () => {
  const r = normalizeCompose(`services:\n  app:\n    image: x\n    volumes:\n      - /config\n`);
  assert.deepEqual(vols(r.text, 'app'), ['./data/app-config:/config']);
  assert.equal(r.changes.length, 1);
});

test('host path is moved, :ro mode is kept', () => {
  const r = normalizeCompose(`services:\n  web:\n    image: x\n    volumes:\n      - /portainer/Files/AppData/Config/web:/var/www/html:ro\n`);
  assert.deepEqual(vols(r.text, 'web'), ['./data/web-var-www-html:/var/www/html:ro']);
  assert.equal(r.warnings.length, 1);
});

test('named volume becomes a folder and is removed from volumes', () => {
  const r = normalizeCompose(`services:
  db:
    image: postgres
    volumes:
      - db_data:/var/lib/postgresql/data
  backup:
    image: x
    volumes:
      - db_data:/backup/db:ro
volumes:
  db_data:
`);
  const doc = parse(r.text);
  assert.deepEqual(doc.services.db.volumes, ['./data/db_data:/var/lib/postgresql/data']);
  assert.deepEqual(doc.services.backup.volumes, ['./data/db_data:/backup/db:ro']);
  assert.equal(doc.volumes, undefined);
});

test('external volume is left unchanged', () => {
  const r = normalizeCompose(`services:
  app:
    image: x
    volumes:
      - shared:/data
volumes:
  shared:
    external: true
`);
  const doc = parse(r.text);
  assert.deepEqual(doc.services.app.volumes, ['shared:/data']);
  assert.ok(doc.volumes.shared.external);
  assert.equal(r.changes.length, 0);
});

test('system, allow-listed, relative and variable paths are kept', () => {
  const src = `services:
  app:
    image: x
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /etc/localtime:/etc/localtime:ro
      - /dev/dri:/dev/dri
      - /mnt/filmy:/movies
      - ./config:/config
      - \${DATA}:/data
`;
  const r = normalizeCompose(src, { hostPathAllowlist: ['/mnt'] });
  assert.equal(r.changes.length, 0);
  assert.equal(r.text, src);
  assert.equal(r.warnings.length, 2); // /mnt + variable
});

test('relative path leaving the stack is moved', () => {
  const r = normalizeCompose(`services:\n  app:\n    image: x\n    volumes:\n      - ../inny/dane:/data\n`);
  assert.deepEqual(vols(r.text, 'app'), ['./data/app-data:/data']);
});

test('long syntax: sourceless volume and host bind', () => {
  const r = normalizeCompose(`services:
  app:
    image: x
    volumes:
      - type: volume
        target: /cache
        volume:
          nocopy: true
      - type: bind
        source: /srv/app
        target: /app
      - type: tmpfs
        target: /tmp
`);
  const v = vols(r.text, 'app');
  assert.deepEqual(v[0], { type: 'bind', source: './data/app-cache', target: '/cache' });
  assert.deepEqual(v[1], { type: 'bind', source: './data/app-app', target: '/app' });
  assert.deepEqual(v[2], { type: 'tmpfs', target: '/tmp' });
});

test('comments in the file are preserved', () => {
  const r = normalizeCompose(`# my app\nservices:\n  app:\n    image: x # version\n    volumes:\n      - /config\n`);
  assert.match(r.text, /# my app/);
  assert.match(r.text, /# version/);
});

test('invalid YAML and missing services give a clear error', () => {
  assert.throws(() => normalizeCompose('services: [\n'), (e) => e.key === 'compose.yamlError');
  assert.throws(() => normalizeCompose('version: "3"\n'), (e) => e.key === 'compose.noServices');
});

test('image VOLUME is added, also without a volumes section', () => {
  const r = addImageVolumes(`services:\n  app:\n    image: x\n  db:\n    image: y\n    volumes:\n      - ./data/db:/var/lib/db\n`, {
    app: ['/data'],
    db: ['/backups'],
  });
  const doc = parse(r.text);
  assert.deepEqual(doc.services.app.volumes, ['./data/app-data:/data']);
  assert.deepEqual(doc.services.db.volumes, ['./data/db:/var/lib/db', './data/db-backups:/backups']);
  assert.equal(r.changes.length, 2);
});

test('detects single-file mounts', () => {
  assert.ok(isFileLikeTarget('/etc/nginx/nginx.conf'));
  assert.ok(isFileLikeTarget('/app/config.yml'));
  assert.ok(!isFileLikeTarget('/etc/nginx/conf.d'));
  assert.ok(!isFileLikeTarget('/config'));
});
