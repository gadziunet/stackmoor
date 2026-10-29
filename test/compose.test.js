import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { normalizeCompose, addImageVolumes, isFileLikeTarget } from '../src/compose.js';

const vols = (text, svc) => parse(text).services[svc].volumes;

test('wolumen anonimowy trafia do ./data', () => {
  const r = normalizeCompose(`services:\n  app:\n    image: x\n    volumes:\n      - /config\n`);
  assert.deepEqual(vols(r.text, 'app'), ['./data/app-config:/config']);
  assert.equal(r.changes.length, 1);
});

test('ścieżka hosta jest przepinana, tryb :ro zostaje', () => {
  const r = normalizeCompose(`services:\n  web:\n    image: x\n    volumes:\n      - /portainer/Files/AppData/Config/web:/var/www/html:ro\n`);
  assert.deepEqual(vols(r.text, 'web'), ['./data/web-var-www-html:/var/www/html:ro']);
  assert.equal(r.warnings.length, 1);
});

test('wolumen nazwany staje się folderem i znika z sekcji volumes', () => {
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

test('wolumen zewnętrzny zostaje bez zmian', () => {
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

test('ścieżki systemowe, dozwolone, względne i ze zmiennymi zostają', () => {
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
  assert.equal(r.warnings.length, 2); // /mnt + zmienna
});

test('ścieżka względna wychodząca poza stack jest przepinana', () => {
  const r = normalizeCompose(`services:\n  app:\n    image: x\n    volumes:\n      - ../inny/dane:/data\n`);
  assert.deepEqual(vols(r.text, 'app'), ['./data/app-data:/data']);
});

test('składnia długa: volume bez źródła i bind z hosta', () => {
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

test('komentarze w pliku zostają', () => {
  const r = normalizeCompose(`# moja aplikacja\nservices:\n  app:\n    image: x # wersja\n    volumes:\n      - /config\n`);
  assert.match(r.text, /# moja aplikacja/);
  assert.match(r.text, /# wersja/);
});

test('błędny YAML i brak services dają czytelny błąd', () => {
  assert.throws(() => normalizeCompose('services: [\n'), /składni YAML/);
  assert.throws(() => normalizeCompose('version: "3"\n'), /services/);
});

test('VOLUME z obrazu jest dopisywany, także gdy brak sekcji volumes', () => {
  const r = addImageVolumes(`services:\n  app:\n    image: x\n  db:\n    image: y\n    volumes:\n      - ./data/db:/var/lib/db\n`, {
    app: ['/data'],
    db: ['/backups'],
  });
  const doc = parse(r.text);
  assert.deepEqual(doc.services.app.volumes, ['./data/app-data:/data']);
  assert.deepEqual(doc.services.db.volumes, ['./data/db:/var/lib/db', './data/db-backups:/backups']);
  assert.equal(r.changes.length, 2);
});

test('rozpoznawanie montowanych plików', () => {
  assert.ok(isFileLikeTarget('/etc/nginx/nginx.conf'));
  assert.ok(isFileLikeTarget('/app/config.yml'));
  assert.ok(!isFileLikeTarget('/etc/nginx/conf.d'));
  assert.ok(!isFileLikeTarget('/config'));
});
