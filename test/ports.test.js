import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishedPorts, parsePsPorts, findConflicts, portFromDockerError } from '../src/ports.js';
import { mountPoints, mountFor } from '../src/mounts.js';
import { translate } from '../src/i18n.js';

const cfg = {
  services: {
    web: { ports: [{ target: 80, published: '8080', protocol: 'tcp' }, { target: 443, published: '8443' }] },
    dns: { ports: [{ target: 53, published: '53', protocol: 'udp', host_ip: '192.168.1.5' }] },
    wol: { network_mode: 'host', ports: [{ target: 1, published: '9' }] },
    range: { ports: [{ target: 6000, published: '6000-6002' }] },
    internal: { ports: [{ target: 3000 }] },
  },
};

test('published ports: mappings, ranges, host network skipped', () => {
  const p = publishedPorts(cfg).map((x) => `${x.svc}:${x.port}/${x.protocol}`);
  assert.deepEqual(p, ['web:8080/tcp', 'web:8443/tcp', 'dns:53/udp', 'range:6000/tcp', 'range:6001/tcp', 'range:6002/tcp']);
});

test('docker ps ports column is parsed (IPv4, IPv6, ranges)', () => {
  const p = parsePsPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:9000-9001->9000-9001/udp, 3000/tcp');
  assert.deepEqual(p.map((x) => `${x.hostIp}|${x.port}/${x.protocol}`), [
    '0.0.0.0|8080/tcp', '::|8080/tcp', '127.0.0.1|9000/udp', '127.0.0.1|9001/udp',
  ]);
});

test('conflicts with other projects are found, own project is ignored', () => {
  const containers = [
    { Names: 'qbittorrent', Ports: '0.0.0.0:8080->8080/tcp, 0.0.0.0:8081->8081/tcp', Labels: 'com.docker.compose.project=qb' },
    { Names: 'demo-web-1', Ports: '0.0.0.0:8443->443/tcp', Labels: 'com.docker.compose.project=demo,x=y' },
    { Names: 'pihole', Ports: '10.0.0.2:53->53/udp', Labels: '' },
  ];
  const c = findConflicts(publishedPorts(cfg), containers, 'demo');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], { svc: 'web', port: 8080, protocol: 'tcp', container: 'qbittorrent', free: 8082 });
});

test('docker error messages give the port', () => {
  assert.equal(portFromDockerError('Bind for 0.0.0.0:8080 failed: port is already allocated'), 8080);
  assert.equal(portFromDockerError('listen tcp4 0.0.0.0:53: bind: address already in use'), 53);
  assert.equal(portFromDockerError('some other error'), null);
});

test('conflict message is translated with a list', () => {
  const msg = translate('pl', 'ports.conflicts', {
    conflicts: [{ svc: 'web', port: 8080, protocol: 'tcp', container: 'qbittorrent', free: 8082 }],
  });
  assert.match(msg, /web: port 8080\/tcp zajmuje kontener „qbittorrent” – wolny jest np\. 8082/);
});

test('stacks folder mount detection', () => {
  const info = [
    '1 0 0:1 / / rw - overlay overlay rw',
    '2 1 0:2 / /app/data rw - ext4 /dev/sda1 rw',
    '3 1 0:3 / /mnt/user/appdata/stackmoor/stacks rw - fuse shfs rw',
    '4 1 0:4 / /my\\040folder rw - ext4 /dev/sdb1 rw',
  ].join('\n');
  const points = mountPoints(info);
  assert.ok(points.includes('/my folder'));
  assert.equal(mountFor('/mnt/user/appdata/stackmoor/stacks', points), '/mnt/user/appdata/stackmoor/stacks');
  assert.equal(mountFor('/opt/stacks', points), '/');
  assert.equal(mountFor('/app/data-other', points), '/');
});
