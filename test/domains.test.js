import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, providerJson } from '../src/dns-providers.js';
import { initSecrets, encrypt, decrypt, mask } from '../src/secrets.js';

test('every provider is built into the Caddy image', () => {
  const dockerfile = fs.readFileSync(new URL('../caddy/Dockerfile', import.meta.url), 'utf8');
  for (const p of PROVIDERS) assert.ok(dockerfile.includes(`--with ${p.module}`), p.id);
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
});

test('provider JSON for Caddy', () => {
  assert.deepEqual(providerJson('cloudflare', { api_token: 'abc' }), { name: 'cloudflare', api_token: 'abc' });
  assert.deepEqual(providerJson('godaddy', { key: 'K', secret: 'S' }), { name: 'godaddy', api_token: 'K:S' });
  assert.deepEqual(providerJson('route53', { access_key_id: 'A', secret_access_key: 'B' }),
    { name: 'route53', access_key_id: 'A', secret_access_key: 'B' });
  assert.equal(providerJson('nope', {}), null);
});

test('every provider has help in both languages', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.help.en && p.help.pl, p.id);
    assert.ok(p.fields.length > 0, p.id);
  }
});

test('secrets are encrypted and can be read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmoor-'));
  initSecrets(dir);
  const blob = encrypt({ api_token: 'top-secret-1234' });
  assert.ok(!blob.includes('top-secret'));
  assert.deepEqual(decrypt(blob), { api_token: 'top-secret-1234' });
  assert.equal(decrypt('v1:broken'), null);
  assert.equal(mask('top-secret-1234'), '••••••1234');
  assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('certificate errors: only after the last success, never "context canceled"', async () => {
  const { certErrors } = await import('../src/caddy-logs.js');
  const line = (o) => JSON.stringify(o);
  const logs = [
    line({ level: 'error', msg: 'could not get certificate from issuer', error: 'old failure' }),
    line({ level: 'info', msg: 'certificate obtained successfully', identifier: '*.dom.example.com' }),
    line({ level: 'error', msg: 'job failed', error: 'provisioning client: context canceled' }),
    'not json',
  ].join('\n');
  assert.deepEqual(certErrors(logs), []);
  const failing = `${logs}\n${line({ level: 'error', msg: 'job failed', error: 'DNS: unauthorized' })}`;
  assert.deepEqual(certErrors(failing), ['job failed: DNS: unauthorized']);
});

test('Caddy image follows the panel version', async () => {
  const { caddyImageFor, DEFAULT_PANEL_SUBDOMAIN } = await import('../src/domains.js');
  assert.equal(caddyImageFor('0.6.1', true), 'ghcr.io/gadziunet/stackmoor-caddy:0.6.1');
  assert.equal(caddyImageFor('v0.7.0', true), 'ghcr.io/gadziunet/stackmoor-caddy:0.7.0');
  assert.equal(caddyImageFor('edge', true), 'ghcr.io/gadziunet/stackmoor-caddy:edge');
  // Local runs (no CI version) have no image of their own.
  assert.equal(caddyImageFor('0.6.0', false), 'ghcr.io/gadziunet/stackmoor-caddy:latest');
  assert.equal(DEFAULT_PANEL_SUBDOMAIN, 'my');
});
