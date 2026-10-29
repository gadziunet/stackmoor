import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repoUrl, dumpKind, dumpCommand, restoreCommand, readyCommand, dataFolders, retentionArgs,
  localParts, isDue, containerName,
} from '../src/backup-plan.js';

test('repository URL', () => {
  assert.equal(repoUrl({ endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'b', prefix: '/stackmoor/' }),
    's3:https://s3.eu-central-003.backblazeb2.com/b/stackmoor');
  assert.equal(repoUrl({ endpoint: 'http://minio:9000/', bucket: 'b', prefix: '' }), 's3:http://minio:9000/b');
});

test('database detection from the image, label wins', () => {
  assert.equal(dumpKind({ image: 'postgres:16' }), 'postgres');
  assert.equal(dumpKind({ image: 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3' }), 'postgres');
  assert.equal(dumpKind({ image: 'tensorchord/pgvecto-rs:pg14-v0.2.0' }), 'postgres');
  assert.equal(dumpKind({ image: 'postgis/postgis:16-3.4' }), 'postgres');
  assert.equal(dumpKind({ image: 'mariadb:11' }), 'mysql');
  assert.equal(dumpKind({ image: 'lscr.io/linuxserver/mariadb' }), 'mysql');
  assert.equal(dumpKind({ image: 'mysql:8.4@sha256:abc' }), 'mysql');
  assert.equal(dumpKind({ image: 'mongo:7' }), 'mongo');
  assert.equal(dumpKind({ image: 'mongo-express' }), null);
  assert.equal(dumpKind({ image: 'redis:7-alpine' }), 'redis');
  assert.equal(dumpKind({ image: 'valkey/valkey:8' }), 'redis');
  assert.equal(dumpKind({ image: 'nextcloud:30' }), null);
  assert.equal(dumpKind({ image: 'postgres:16', labels: { 'stackmoor.backup.dump': 'none' } }), null);
  assert.equal(dumpKind({ image: 'my/db', labels: ['stackmoor.backup.dump=mysql'] }), 'mysql');
});

test('dump, restore and ready commands exist for every database', () => {
  for (const kind of ['postgres', 'mysql', 'mongo']) {
    assert.ok(dumpCommand(kind) && restoreCommand(kind) && readyCommand(kind), kind);
  }
  assert.match(dumpCommand('postgres'), /pg_dumpall/);
  assert.match(dumpCommand('mysql'), /--single-transaction/);
  // Ready checks go over TCP so the init-only server (no networking) does not count.
  assert.match(readyCommand('postgres'), /-h 127\.0\.0\.1/);
  assert.match(readyCommand('mysql'), /-h 127\.0\.0\.1/);
  assert.equal(restoreCommand('redis'), null);
});

test('database folders inside the stack are left out, others are not', () => {
  const def = {
    volumes: [
      { type: 'bind', source: '/opt/stacks/app/data/db', target: '/var/lib/postgresql/data' },
      { type: 'bind', source: '/opt/stacks/app', target: '/whole' },
      { type: 'bind', source: '/mnt/media', target: '/media' },
      { type: 'volume', source: 'named', target: '/x' },
    ],
  };
  assert.deepEqual(dataFolders('/opt/stacks/app', def), ['/opt/stacks/app/data/db']);
  assert.equal(containerName('app', 'db', {}), 'app-db-1');
  assert.equal(containerName('app', 'db', { container_name: 'pg' }), 'pg');
});

test('retention arguments', () => {
  assert.deepEqual(retentionArgs({ keepDaily: 3, keepWeekly: 0, keepMonthly: 12 }),
    ['--group-by', 'tags', '--keep-last', '1', '--keep-daily', '3', '--keep-weekly', '0', '--keep-monthly', '12']);
});

test('schedule: chosen days and time, in the user\'s time zone, once a day', () => {
  // 2026-10-29 is a Thursday. 02:10 UTC = 03:10 in Warsaw (CET).
  const now = new Date('2026-10-29T02:10:00Z');
  assert.deepEqual(localParts(now, 'Europe/Warsaw'), { day: 4, time: '03:10', date: '2026-10-29' });
  const cfg = { enabled: true, days: [4], time: '03:00', timeZone: 'Europe/Warsaw' };
  assert.equal(isDue(cfg, null, now), true);
  assert.equal(isDue(cfg, '2026-10-29', now), false, 'already ran today');
  assert.equal(isDue({ ...cfg, days: [1, 2] }, null, now), false, 'not a chosen day');
  assert.equal(isDue({ ...cfg, time: '04:00' }, null, now), false, 'too early');
  assert.equal(isDue({ ...cfg, time: '01:00' }, null, now), false, 'more than an hour late');
  assert.equal(isDue({ ...cfg, enabled: false }, null, now), false);
  assert.equal(isDue({ ...cfg, timeZone: 'Not/AZone' }, null, now), false, 'bad zone falls back to UTC (02:10)');
});
