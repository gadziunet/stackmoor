import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSettings, saveSettings, getState } from '../src/db.js';
import { parseHostInfo, readUptime, autoRebootConfig, patchesConfig, createSystem } from '../src/system.js';

test('the server state from the helper output', () => {
  const out = [
    'os=Debian GNU/Linux 13 (trixie)',
    'reboot=1',
    'pkgs=linux-image-amd64 libc6 ',
    'systemd=1',
    'apt=1',
    'uu=1',
    'APT::Periodic::Unattended-Upgrade "1";',
    'Unattended-Upgrade::Automatic-Reboot "true";',
    'Unattended-Upgrade::Automatic-Reboot-Time "04:00";',
  ].join('\n');
  assert.deepEqual(parseHostInfo(out), {
    os: 'Debian GNU/Linux 13 (trixie)', rebootRequired: true, packages: ['linux-image-amd64', 'libc6'],
    systemd: true, apt: true, unraid: false,
    patches: { installed: true, enabled: true, autoReboot: true, rebootTime: '04:00' },
  });
  // Turned on in the config but the package is missing = not working.
  const half = parseHostInfo('os=Ubuntu\napt=1\nAPT::Periodic::Unattended-Upgrade "1";');
  assert.equal(half.patches.enabled, false);
  assert.equal(parseHostInfo('os=Unraid\nunraid=1').unraid, true);
});

test('apt config files written on the server', () => {
  assert.equal(patchesConfig(true), 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n');
  assert.match(autoRebootConfig(true, '04:30'), /Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:30";/);
  assert.ok(!autoRebootConfig(false, '04:30').includes("'"), 'no single quotes – the text goes inside printf \'…\'');
});

test('uptime is read from /proc/uptime', () => {
  const f = path.join(os.tmpdir(), `uptime-${process.pid}`);
  fs.writeFileSync(f, '3600.42 12000.00\n');
  assert.equal(readUptime(f), 3600);
  assert.equal(readUptime('/nonexistent'), null);
});

test('after the server restarts, stacks that ran before start again', async () => {
  const db = openDb(':memory:');
  let boot = 'boot-1';
  const states = { web: 'running', db: 'running', old: 'exited', manual: 'running' };
  const started = [];
  const stacks = {
    list: async () => Object.entries(states).map(([name, state]) => ({ name, state, busy: false })),
    action: async (name, act, _w, { label }) => {
      if (name === 'db' && states.db === 'locked') throw new Error('busy');
      started.push([name, act, label]); states[name] = 'running'; return true;
    },
  };
  const sys = createSystem({
    db, stacks, updates: {}, backups: { busy: () => false }, autoUpdate: { busy: () => false },
    getSettings: () => getSettings(db), saveSettings: (p) => saveSettings(db, p),
    getT: () => (k) => k, readBoot: () => boot, pause: async () => {},
  });
  await sys.saveRunning();
  assert.deepEqual(getState(db, 'system.running').names.sort(), ['db', 'manual', 'web']);

  // Same boot (the panel itself restarted): nothing to do.
  assert.deepEqual(await sys.afterBoot(), []);

  // The server restarted: "web" has restart: unless-stopped, "db" has none and stayed down.
  boot = 'boot-2';
  Object.assign(states, { web: 'running', db: 'exited', manual: 'exited' });
  assert.deepEqual(await sys.afterBoot(), ['db', 'manual']);
  assert.deepEqual(started, [['db', 'up', 'boot'], ['manual', 'up', 'boot']]);
  assert.equal(states.old, 'exited', 'a stack that was stopped before stays stopped');

  // One stack that can't start doesn't stop the others.
  boot = 'boot-3';
  await sys.saveRunning();
  boot = 'boot-4';
  Object.assign(states, { db: 'locked', manual: 'exited' });
  started.length = 0;
  assert.deepEqual(await sys.afterBoot(), ['manual']);
});
