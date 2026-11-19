import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repoUrl, dumpKind, dumpCommand, restoreCommand, readyCommand, dataFolders, retentionArgs,
  localParts, isDue, containerName, imageRepo, pickDigest, recordImages, imagesPlan, psqlLine, sharedRefs, limitedShell,
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
    ['--group-by', 'paths', '--keep-last', '1', '--keep-daily', '3', '--keep-weekly', '0', '--keep-monthly', '12']);
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

test('runs: tagged snapshots are grouped by their run id', async () => {
  const { groupRuns, newRunId } = await import('../src/backup-plan.js');
  assert.match(newRunId(new Date('2026-10-30T03:00:12Z')), /^20261030-030012-[a-z0-9]{1,4}$/);
  const snap = (id, time, tags, extra = {}) => ({ id, time, tags, system: tags.includes('system'), preUpdate: tags.includes('pre-update'), stack: (tags.find((t) => t.startsWith('stack:')) || '').slice(6) || null, size: 10, ...extra });
  const runs = groupRuns([
    snap('a', '2026-10-30T03:00:01Z', ['stack:wordpress', 'auto', 'run:R1', 'kind:scheduled']),
    snap('b', '2026-10-30T03:00:05Z', ['stack:nginx', 'auto', 'run:R1', 'kind:scheduled']),
    snap('c', '2026-10-30T03:00:09Z', ['system', 'auto', 'run:R1', 'kind:scheduled']),
    snap('d', '2026-10-30T14:00:00Z', ['stack:nginx', 'pre-update', 'run:R2', 'kind:pre-update']),
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, 'R2');
  assert.equal(runs[0].kind, 'pre-update');
  assert.deepEqual(runs[1].stacks.map((s) => s.stack), ['nginx', 'wordpress']);
  assert.equal(runs[1].system.id, 'c');
  assert.equal(runs[1].size, 20);
});

test('runs: snapshots from 0.5 (no run tag) are grouped by time around system snapshots', async () => {
  const { groupRuns } = await import('../src/backup-plan.js');
  const snap = (id, time, tags) => ({ id, time, tags, system: tags.includes('system'), preUpdate: tags.includes('pre-update'), stack: (tags.find((t) => t.startsWith('stack:')) || '').slice(6) || null, size: 1 });
  const runs = groupRuns([
    snap('old', '2026-10-28T10:00:00Z', ['stack:wordpress']),                 // manual, long before
    snap('w', '2026-10-29T03:00:01Z', ['stack:wordpress']),
    snap('n', '2026-10-29T03:00:05Z', ['stack:nginx']),
    snap('s', '2026-10-29T03:00:09Z', ['system']),
    snap('p', '2026-10-29T12:00:00Z', ['stack:nginx', 'pre-update']),
    snap('m', '2026-10-29T22:47:40Z', ['stack:wordpress']),                   // manual, no system after
  ]);
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.deepEqual(byId['legacy-s'].stacks.map((x) => x.id), ['n', 'w']);
  assert.equal(byId['legacy-s'].kind, 'scheduled');
  assert.equal(byId['legacy-old'].kind, 'manual');
  assert.equal(byId['legacy-p'].kind, 'pre-update');
  assert.equal(byId['legacy-m'].stacks.length, 1);
  assert.equal(runs.length, 4);
});

test('paths left out of a stack backup', async () => {
  const { cleanExcludes, excludeArgs } = await import('../src/backup-plan.js');
  assert.deepEqual(cleanExcludes('data/app/cache\n\n ./data/*/thumbs/ \ndata/app/cache'), ['data/app/cache', 'data/*/thumbs']);
  assert.throws(() => cleanExcludes('/etc'), { key: 'backup.badExclude' });
  assert.throws(() => cleanExcludes('compose.yaml'), { key: 'backup.badExclude' });
  assert.throws(() => cleanExcludes('**'), { key: 'backup.badExclude' });
  assert.throws(() => cleanExcludes('data/../../etc'), { key: 'backup.badExclude' });
  assert.deepEqual(excludeArgs('/opt/stacks/immich/', ['data/thumbs', 'data/**/cache']),
    ['--exclude', '/opt/stacks/immich/data/thumbs', '--exclude', '/opt/stacks/immich/data/**/cache']);
});

test('snapshot stack tag: only a stack name is accepted, a path makes the snapshot unusable', async () => {
  const { snapshotStack } = await import('../src/backup-plan.js');
  assert.equal(snapshotStack(['run:x', 'stack:wordpress']), 'wordpress');
  assert.equal(snapshotStack(['system', 'run:x']), null);
  assert.equal(snapshotStack([]), null);
  for (const bad of ['stack:../../../app/src', 'stack:/etc', 'stack:a/b', 'stack:', 'stack:-p', 'stack:Big', 'stack:.hidden']) {
    assert.equal(snapshotStack([bad]), false, bad);
  }
});

test('dump manifest: only known kinds, services of the stack and the exact file name are used', async () => {
  const { cleanManifest } = await import('../src/backup-plan.js');
  const services = ['db', 'app'];
  assert.deepEqual(cleanManifest([{ service: 'db', kind: 'postgres', file: 'db.postgres.sql', size: 10 }], services),
    [{ service: 'db', kind: 'postgres', file: 'db.postgres.sql', size: 10 }]);
  assert.deepEqual(cleanManifest(undefined, services), []);
  const bad = [
    { service: 'db', kind: 'postgres', file: '../../../../app/data/secret.key' }, // a path instead of the dump
    { service: 'db', kind: 'postgres', file: 'other.postgres.sql' },              // another file
    { service: 'db', kind: 'shell', file: 'db.shell.sql' },                       // unknown kind
    { service: '--privileged', kind: 'postgres', file: '--privileged.postgres.sql' }, // not a service
    { service: 'cache', kind: 'redis', file: 'cache.redis' },                     // redis has no dump file
  ];
  for (const m of bad) {
    assert.throws(() => cleanManifest([m], services), (e) => e.key === 'backup.badManifest', JSON.stringify(m));
  }
});

const ID = (c) => `sha256:${c.repeat(64)}`;

test('image repository and digest for a reference', () => {
  assert.equal(imageRepo('postgres:16'), 'postgres');
  assert.equal(imageRepo('registry.example.com:5000/team/app:1.2'), 'registry.example.com:5000/team/app');
  assert.equal(imageRepo('registry.example.com:5000/team/app'), 'registry.example.com:5000/team/app');
  assert.equal(imageRepo(`ghcr.io/x/app@${ID('a')}`), 'ghcr.io/x/app');
  const digests = [`other/app@${ID('1')}`, `ghcr.io/x/app@${ID('2')}`];
  assert.equal(pickDigest('ghcr.io/x/app:latest', digests), `ghcr.io/x/app@${ID('2')}`);
  assert.equal(pickDigest('nothing:here', digests), `other/app@${ID('1')}`);
  assert.equal(pickDigest('a:b', ['bad digest', '']), null);
  assert.equal(pickDigest('a:b', undefined), null);
});

test('a backup records the exact image of every service', () => {
  const c = (svc, ref, id) => ({ Config: { Image: ref, Labels: { 'com.docker.compose.service': svc } }, Image: id });
  const record = recordImages(
    [c('web', 'ghcr.io/x/app:latest', ID('a')), c('web', 'ghcr.io/x/app:latest', ID('a')), c('db', 'postgres:16', ID('b')),
      c('built', 'demo-built', ID('c')), c('broken', 'x:1', 'not-an-id'), { Config: {}, Image: ID('d') }],
    [{ Id: ID('a'), RepoDigests: [`ghcr.io/x/app@${ID('e')}`] }, { Id: ID('b'), RepoDigests: [`postgres@${ID('f')}`] }, { Id: ID('c'), RepoDigests: [] }],
  );
  assert.deepEqual(record, { version: 1, images: [
    { service: 'web', ref: 'ghcr.io/x/app:latest', id: ID('a'), digest: `ghcr.io/x/app@${ID('e')}` },
    { service: 'db', ref: 'postgres:16', id: ID('b'), digest: `postgres@${ID('f')}` },
    { service: 'built', ref: 'demo-built', id: ID('c'), digest: null },
  ] });
});

test('a restore only trusts the recorded ids and digests, the names come from the compose file', () => {
  const services = { web: { image: 'ghcr.io/x/app:latest' }, db: { image: 'postgres:16' }, edited: { image: 'app:2' }, pinned: { image: `postgres@${ID('9')}` }, build: { build: '.' } };
  const plan = imagesPlan({ images: [
    { service: 'web', ref: 'ghcr.io/x/app:latest', id: ID('a'), digest: `ghcr.io/x/app@${ID('e')}` },
    { service: 'web', ref: 'ghcr.io/x/app:latest', id: ID('1') }, // the same service twice: the first counts
    { service: 'db', ref: 'postgres:16', id: '--force', digest: `postgres@${ID('f')}` },
    { service: 'edited', ref: 'app:1', id: ID('5') }, // compose.yaml now says app:2
    { service: 'pinned', id: ID('2') }, // pinned in compose.yaml: nothing to do
    { service: 'build', id: ID('3') }, // no image name in compose.yaml
    { service: 'gone', id: ID('4') }, // not in the restored compose file
    { service: 'web2', id: 'x', digest: 'y' },
  ] }, services);
  assert.deepEqual(plan, [
    { service: 'web', ref: 'ghcr.io/x/app:latest', id: ID('a'), digest: `ghcr.io/x/app@${ID('e')}` },
    { service: 'db', ref: 'postgres:16', id: null, digest: `postgres@${ID('f')}` },
  ]);
  assert.deepEqual(imagesPlan(null, services), []);
  assert.deepEqual(imagesPlan({ images: 'nope' }, services), []);
  assert.deepEqual(imagesPlan({ images: [{ service: 'db', ref: 'postgres:16', id: 'bad', digest: 'bad' }] }, services), []);
});

test('psql errors while importing: "already exists" is harmless, anything else fails the restore', () => {
  assert.equal(psqlLine('psql:<stdin>:14: ERROR:  role "postgres" already exists'), 'ignored');
  assert.equal(psqlLine('psql:<stdin>:20: ERROR:  database "app" already exists'), 'ignored');
  assert.equal(psqlLine('psql:<stdin>:99: ERROR:  duplicate key value violates unique constraint "users_pkey"'), 'error');
  assert.equal(psqlLine('psql:<stdin>:7: ERROR:  could not open extension control file "vector.control"'), 'error');
  assert.equal(psqlLine('psql: FATAL:  password authentication failed'), 'error');
  // Only roles and databases: a table the app already made means the schema may differ.
  assert.equal(psqlLine('psql:<stdin>:40: ERROR:  relation "users" already exists'), 'error');
  assert.equal(psqlLine('SET'), null);
  assert.equal(psqlLine('NOTICE:  table "x" does not exist, skipping'), null);
});

test('image names used by other stacks are found', () => {
  const shared = sharedRefs('demo\tpostgres:16\nother\tpostgres:16\nthird\tpostgres:16\nother\tpostgres:16\n\tbare:1\ndemo\tonly:mine\n', 'demo');
  assert.deepEqual(shared.get('postgres:16'), ['other', 'third']);
  assert.equal(shared.has('only:mine'), false);
  assert.equal(shared.has('bare:1'), false);
});

test('database commands get a time limit inside the container', () => {
  const args = limitedShell('pg_dumpall -U "$X"', 6 * 3600e3);
  assert.equal(args[0], 'sh');
  assert.equal(args[3], '21600');
  assert.equal(args[4], 'pg_dumpall -U "$X"'); // passed as an argument, never pasted into the script
  assert.match(args[2], /exec timeout "\$0" sh -c "\$1"/);
});
