import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings, saveSettings, getState } from '../src/db.js';
import { judgeContainers, waitHealthy, createAutoUpdate, cleanAutoUpdate } from '../src/autoupdate.js';
import { cleanSchedule } from '../src/schedule.js';

const box = (svc, status, extra = {}) => ({
  Id: `id-${svc}`, Name: `/demo-${svc}-1`, RestartCount: extra.restarts || 0, Image: extra.image || 'sha256:old',
  Config: { Image: `example/${svc}:latest`, Labels: { 'com.docker.compose.service': svc } },
  State: { Status: status, ExitCode: extra.code ?? 0, ...(extra.health ? { Health: { Status: extra.health } } : {}) },
});

test('containers after an update: fine, still starting, or broken', () => {
  assert.equal(judgeContainers([box('web', 'running'), box('migrate', 'exited')]).verdict, 'ok');
  assert.equal(judgeContainers([box('web', 'running', { health: 'starting' })]).verdict, 'wait');
  assert.equal(judgeContainers([box('web', 'running', { health: 'healthy' })]).verdict, 'ok');
  assert.deepEqual(judgeContainers([box('web', 'running', { health: 'unhealthy' })]), { verdict: 'fail', reason: 'unhealthy', service: 'web' });
  assert.deepEqual(judgeContainers([box('db', 'exited', { code: 1 })]), { verdict: 'fail', reason: 'exited', service: 'db', code: 1 });
  assert.equal(judgeContainers([box('web', 'restarting')]).reason, 'restarting');
  // Running right now, but restarted since the first look = crash loop.
  assert.equal(judgeContainers([box('web', 'running', { restarts: 3 })], { 'id-web': 1 }).reason, 'restarting');
  assert.equal(judgeContainers([]).reason, 'none');
});

test('waiting for healthy containers uses the settle time and gives up after the timeout', async () => {
  let clock = 0;
  const opts = { settle: 30e3, timeout: 60e3, every: 5e3, wait: async (ms) => { clock += ms; }, now: () => clock };
  assert.deepEqual(await waitHealthy(async () => [box('web', 'running')], opts), { ok: true });
  assert.equal(clock, 30e3);
  clock = 0;
  assert.equal((await waitHealthy(async () => [box('web', 'running', { health: 'starting' })], opts)).reason, 'timeout');
  clock = 0;
  let n = 0;
  const flapping = async () => [box('web', 'running', { restarts: n++ > 2 ? 1 : 0 })];
  assert.equal((await waitHealthy(flapping, opts)).reason, 'restarting');
});

test('schedules and settings from the form are checked', () => {
  const old = { enabled: false, days: [0, 1], time: '04:00', timeZone: 'UTC' };
  assert.deepEqual(cleanSchedule({ enabled: true, days: [3, '1', 9, 3], time: '25:00', timeZone: 'Nowhere/City' }, old),
    { enabled: true, days: [1, 3], time: '04:00', timeZone: 'UTC' });
  assert.equal(cleanSchedule({ time: '23:59', timeZone: 'Europe/Warsaw' }, old).timeZone, 'Europe/Warsaw');
  const a = cleanAutoUpdate({ enabled: true, exclude: ['db', 'BAD NAME', 'db'] });
  assert.equal(a.enabled, true);
  assert.deepEqual(a.exclude, ['db']);
});

// A pretend stack: "update" swaps the image; the new one may be broken.
function world({ broken }) {
  const db = openDb(':memory:');
  let image = 'sha256:old';
  const tags = [];
  const names = {}; // image name -> id, like Docker's tags
  const ops = [];
  const stacks = {
    list: async () => [{ name: 'demo', state: 'running' }, { name: 'off', state: 'exited' }, { name: 'skip', state: 'running' }],
    isBusy: () => false,
    compose: async () => ({ stdout: 'id-web\n' }),
    action: async (name, act, write, { label }) => {
      ops.push(label);
      if (act === 'update') image = 'sha256:new';
      if (act === 'up') image = names['example/web:latest'] || image;
      return true;
    },
  };
  const run = async (args) => {
    if (args[0] === 'inspect') {
      const bad = broken && image === 'sha256:new';
      return { code: 0, stdout: JSON.stringify([box('web', bad ? 'exited' : 'running', { image, code: bad ? 137 : 0 })]) };
    }
    if (args[0] === 'tag') {
      tags.push(`${args[1]} -> ${args[2]}`);
      names[args[2]] = args[1].startsWith('sha256:') ? args[1] : names[args[1]];
      return { code: names[args[2]] ? 0 : 1, output: '' };
    }
    if (args[0] === 'rmi') { tags.push(`rmi ${args[1]}`); delete names[args[1]]; return { code: 0, output: '' }; }
    return { code: 0, stdout: '', output: '' };
  };
  const checked = [];
  const updates = {
    checkStack: async (name) => {
      checked.push(name);
      return { images: [{ image: 'example/web:latest', updateAvailable: image === 'sha256:old' }] };
    },
  };
  saveSettings(db, { autoUpdate: { ...getSettings(db).autoUpdate, exclude: ['skip'] } });
  const auto = createAutoUpdate({
    db, stacks, updates, backups: { busy: () => false },
    getSettings: () => getSettings(db), saveSettings: (p) => saveSettings(db, p),
    getT: () => (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`,
    run, healthOpts: { settle: 0, every: 0, wait: async () => {} },
  });
  return { db, auto, tags, ops, checked };
}

test('a working update stays; stopped and excluded stacks are left alone', async () => {
  const w = world({ broken: false });
  const done = await w.auto.runAll('manual');
  assert.deepEqual(done.map((r) => [r.stack, r.result]), [['demo', 'updated']]);
  assert.deepEqual(w.ops, ['autoupdate']);
  // The old image is kept under an extra name during the update, then let go.
  assert.deepEqual(w.tags, ['sha256:old -> stackmoor-rollback/demo:0', 'rmi stackmoor-rollback/demo:0']);
  assert.deepEqual(w.checked, ['demo', 'demo']); // before, and again so the badge clears
  assert.equal(getState(w.db, 'autoupdate.runs')[0].result, 'updated');
});

test('a broken update goes back to the previous images', async () => {
  const w = world({ broken: true });
  const [r] = await w.auto.runAll('scheduled');
  assert.equal(r.result, 'rolledBack');
  assert.match(r.reason, /auto\.reason\.exited/);
  assert.deepEqual(w.ops, ['autoupdate', 'rollback']);
  assert.deepEqual(w.tags, [
    'sha256:old -> stackmoor-rollback/demo:0',
    'stackmoor-rollback/demo:0 -> example/web:latest',
    'rmi stackmoor-rollback/demo:0',
  ]);
});
