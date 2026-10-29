import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newestTag, isSemver } from '../src/version.js';
import { parseImageRef, parseChallenge, localDigests, remoteDigest } from '../src/registry.js';

test('version comparison', () => {
  assert.ok(compareVersions('0.1.2', '0.1.1') > 0);
  assert.ok(compareVersions('v0.2.0', '0.10.0') < 0);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  assert.equal(compareVersions('edge', '0.1.0'), null);
  assert.equal(isSemver('edge'), false);
  assert.equal(newestTag(['v0.1.0', 'v0.10.0', 'v0.9.1', 'v1.0.0-rc.1', 'test']), 'v0.10.0');
});

test('image references', () => {
  assert.deepEqual(parseImageRef('nginx:alpine'), { registry: 'docker.io', repo: 'library/nginx', tag: 'alpine', key: 'docker.io/library/nginx' });
  assert.equal(parseImageRef('nginx').tag, 'latest');
  assert.equal(parseImageRef('linuxserver/sonarr').key, 'docker.io/linuxserver/sonarr');
  assert.deepEqual(parseImageRef('ghcr.io/seriousm4x/upsnap:5'), { registry: 'ghcr.io', repo: 'seriousm4x/upsnap', tag: '5', key: 'ghcr.io/seriousm4x/upsnap' });
  assert.equal(parseImageRef('registry.local:5000/team/app:1.2').registry, 'registry.local:5000');
  assert.equal(parseImageRef('registry.local:5000/team/app').tag, 'latest');
  assert.ok(parseImageRef('nginx@sha256:abc').pinned);
});

test('registry auth challenge', () => {
  const c = parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"');
  assert.equal(c.realm, 'https://auth.docker.io/token');
  assert.equal(c.service, 'registry.docker.io');
  assert.equal(parseChallenge('Basic realm="x"'), null);
});

test('local digests are matched by repository', () => {
  const d = localDigests('nginx:alpine', ['nginx@sha256:aaa', 'ghcr.io/x/nginx@sha256:bbb']);
  assert.deepEqual(d, ['sha256:aaa']);
  assert.deepEqual(localDigests('ghcr.io/x/nginx:1', ['nginx@sha256:aaa', 'ghcr.io/x/nginx@sha256:bbb']), ['sha256:bbb']);
});

test('remote digest with token flow', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method || 'GET'} ${u}`);
    if (u.startsWith('https://auth.docker.io/token')) {
      return new Response(JSON.stringify({ token: 'T' }), { status: 200 });
    }
    if (opts.headers?.Authorization === 'Bearer T') {
      return new Response(null, { status: 200, headers: { 'docker-content-digest': 'sha256:new' } });
    }
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' },
    });
  };
  try {
    assert.equal(await remoteDigest('nginx:alpine'), 'sha256:new');
    assert.ok(calls[0].startsWith('HEAD https://registry-1.docker.io/v2/library/nginx/manifests/alpine'));
    assert.ok(calls[1].includes('scope=repository%3Alibrary%2Fnginx%3Apull'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
