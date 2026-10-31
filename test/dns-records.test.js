import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneCandidates, relativeName, upsertRecord, checkDomain, isPrivateIPv4, AUTO_RECORD_PROVIDERS } from '../src/dns-records.js';
import { PROVIDERS } from '../src/dns-providers.js';

/** A fake provider API: routes are "METHOD path" → (body, url) => [status, json]. Records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}`;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ key, url: String(url), body, headers: opts.headers });
    const handler = routes[key];
    const [status, json] = handler ? handler(body, u) : [404, { message: 'not found' }];
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status });
  };
  fn.calls = calls;
  return fn;
}

test('zone candidates and relative names', () => {
  assert.deepEqual(zoneCandidates('home.example.co.uk'), ['home.example.co.uk', 'example.co.uk', 'co.uk']);
  assert.equal(relativeName('*.home.example.com', 'example.com'), '*.home');
  assert.equal(relativeName('*.example.com', 'example.com'), '*');
  assert.ok(isPrivateIPv4('192.168.10.5') && isPrivateIPv4('10.0.0.1') && isPrivateIPv4('172.20.1.1'));
  assert.ok(!isPrivateIPv4('8.8.8.8') && !isPrivateIPv4('my.example.com'));
});

test('every provider with an automatic record exists in the provider list', () => {
  for (const id of AUTO_RECORD_PROVIDERS) assert.ok(PROVIDERS.some((p) => p.id === id), id);
});

test('Cloudflare: finds the parent zone and creates *.home', async () => {
  const f = fakeFetch({
    'GET /client/v4/zones': (_b, u) => [200, { success: true, result: u.searchParams.get('name') === 'example.com' ? [{ id: 'Z1' }] : [] }],
    'GET /client/v4/zones/Z1/dns_records': () => [200, { success: true, result: [] }],
    'POST /client/v4/zones/Z1/dns_records': () => [200, { success: true, result: {} }],
  });
  const r = await upsertRecord({ domain: 'home.example.com', provider: 'cloudflare', credentials: { api_token: 'T' }, ip: '192.168.1.5', fetchFn: f });
  assert.equal(r.action, 'created');
  assert.equal(r.zone, 'example.com');
  // Both the wildcard and the domain itself.
  const posts = f.calls.filter((c) => c.key.startsWith('POST'));
  assert.deepEqual(posts.map((p) => p.body.name), ['*.home.example.com', 'home.example.com']);
  assert.deepEqual(posts[0].body, { type: 'A', name: '*.home.example.com', content: '192.168.1.5', ttl: 1, proxied: false });
  assert.equal(posts[0].headers.Authorization, 'Bearer T');
});

test('Cloudflare: same IP → unchanged, other IP → updated', async () => {
  let content = '192.168.1.5';
  const f = fakeFetch({
    'GET /client/v4/zones': () => [200, { success: true, result: [{ id: 'Z1' }] }],
    'GET /client/v4/zones/Z1/dns_records': () => [200, { success: true, result: [{ id: 'R1', content }] }],
    'PATCH /client/v4/zones/Z1/dns_records/R1': (b) => { content = b.content; return [200, { success: true }]; },
  });
  const args = { domain: 'example.com', provider: 'cloudflare', credentials: { api_token: 'T' }, fetchFn: f };
  assert.equal((await upsertRecord({ ...args, ip: '192.168.1.5' })).action, 'unchanged');
  assert.equal((await upsertRecord({ ...args, ip: '192.168.1.9' })).action, 'updated');
  assert.equal(content, '192.168.1.9');
});

test('Cloudflare: a rejected token is reported as auth', async () => {
  const f = fakeFetch({ 'GET /client/v4/zones': () => [403, { success: false }] });
  const r = await checkDomain({ domain: 'home.example.com', provider: 'cloudflare', credentials: { api_token: 'bad' }, fetchFn: f, lookupFn: async () => [] });
  assert.equal(r.api.ok, false);
  assert.equal(r.api.kind, 'auth');
});

test('Bunny: relative record name in the zone', async () => {
  const f = fakeFetch({
    'GET /dnszone': () => [200, { Items: [{ Id: 7, Domain: 'example.com', Records: [{ Id: 1, Type: 0, Name: 'www', Value: '1.1.1.1' }] }] }],
    'PUT /dnszone/7/records': () => [201, {}],
  });
  const r = await upsertRecord({ domain: 'dom.example.com', provider: 'bunny', credentials: { access_key: 'K' }, ip: '192.168.1.2', fetchFn: f });
  assert.equal(r.action, 'created');
  const puts = f.calls.filter((c) => c.key.startsWith('PUT'));
  assert.deepEqual(puts.map((p) => p.body), [
    { Type: 0, Name: '*.dom', Value: '192.168.1.2', Ttl: 300 },
    { Type: 0, Name: 'dom', Value: '192.168.1.2', Ttl: 300 },
  ]);
  assert.equal(f.calls[0].headers.AccessKey, 'K');
});

test('Hetzner, deSEC, DigitalOcean, Porkbun: create the record', async () => {
  const hz = fakeFetch({
    'GET /v1/zones': (_b, u) => [200, { zones: u.searchParams.get('name') === 'example.com' ? [{ id: 42 }] : [] }],
    'GET /v1/zones/42/rrsets/*.home/A': () => [404, {}],
    'GET /v1/zones/42/rrsets/home/A': () => [404, {}],
    'POST /v1/zones/42/rrsets': () => [201, {}],
  });
  assert.equal((await upsertRecord({ domain: 'home.example.com', provider: 'hetzner', credentials: { api_token: 'T' }, ip: '10.0.0.2', fetchFn: hz })).action, 'created');
  assert.deepEqual(hz.calls.filter((c) => c.key === 'POST /v1/zones/42/rrsets').map((c) => c.body.name), ['*.home', 'home']);
  assert.deepEqual(hz.calls.find((c) => c.key === 'POST /v1/zones/42/rrsets').body, { name: '*.home', type: 'A', ttl: 300, records: [{ value: '10.0.0.2' }] });

  const ds = fakeFetch({
    'GET /api/v1/domains/': () => [200, [{ name: 'example.com' }]],
    'GET /api/v1/domains/example.com/rrsets/*.home/A/': () => [404, {}],
    'GET /api/v1/domains/example.com/rrsets/home/A/': () => [404, {}],
    'PUT /api/v1/domains/example.com/rrsets/': () => [200, []],
  });
  assert.equal((await upsertRecord({ domain: 'home.example.com', provider: 'desec', credentials: { token: 'T' }, ip: '10.0.0.2', fetchFn: ds })).action, 'created');
  assert.deepEqual(ds.calls.filter((c) => c.key.startsWith('PUT')).map((c) => c.body[0].subname), ['*.home', 'home']);

  const doo = fakeFetch({
    'GET /v2/domains/home.example.com': () => [404, {}],
    'GET /v2/domains/example.com': () => [200, { domain: { name: 'example.com' } }],
    'GET /v2/domains/example.com/records': () => [200, { domain_records: [] }],
    'POST /v2/domains/example.com/records': () => [201, {}],
  });
  assert.equal((await upsertRecord({ domain: 'home.example.com', provider: 'digitalocean', credentials: { auth_token: 'T' }, ip: '10.0.0.2', fetchFn: doo })).action, 'created');
  assert.deepEqual(doo.calls.filter((c) => c.key.startsWith('POST')).map((c) => c.body.name), ['*.home', 'home']);

  const pb = fakeFetch({
    'POST /api/json/v3/dns/retrieve/home.example.com': () => [400, { status: 'ERROR', message: 'Invalid domain.' }],
    'POST /api/json/v3/dns/retrieve/example.com': () => [200, { status: 'SUCCESS', records: [] }],
    'POST /api/json/v3/dns/retrieveByNameType/example.com/A/*.home': () => [200, { status: 'SUCCESS', records: [] }],
    'POST /api/json/v3/dns/retrieveByNameType/example.com/A/home': () => [200, { status: 'SUCCESS', records: [] }],
    'POST /api/json/v3/dns/create/example.com': () => [200, { status: 'SUCCESS', id: 1 }],
  });
  assert.equal((await upsertRecord({ domain: 'home.example.com', provider: 'porkbun', credentials: { api_key: 'a', api_secret_key: 's' }, ip: '10.0.0.2', fetchFn: pb })).action, 'created');
  assert.deepEqual(pb.calls.filter((c) => c.key.includes('/dns/create/')).map((c) => c.body.name), ['*.home', 'home']);
  assert.equal(pb.calls.at(-1).body.apikey, 'a');
});

test('check: an existing record pointing elsewhere means the domain is in use', async () => {
  const f = fakeFetch({
    'GET /client/v4/zones': () => [200, { success: true, result: [{ id: 'Z1' }] }],
    'GET /client/v4/zones/Z1/dns_records': () => [200, { success: true, result: [{ id: 'R1', content: '203.0.113.7' }] }],
  });
  const base = { domain: 'home.example.com', provider: 'cloudflare', credentials: { api_token: 'T' }, fetchFn: f };
  const busy = await checkDomain({ ...base, serverIp: '192.168.1.5' });
  assert.equal(busy.source, 'api');
  assert.deepEqual(busy.existing, ['203.0.113.7']);
  assert.equal(busy.inUse, true);
  const mine = await checkDomain({ ...base, serverIp: '203.0.113.7' });
  assert.equal(mine.inUse, false);
});

test('check: providers without an API client fall back to a DNS lookup', async () => {
  const r = await checkDomain({ domain: 'home.example.com', provider: 'ovh', credentials: {}, serverIp: '192.168.1.5', lookupFn: async () => ['192.168.1.9'] });
  assert.equal(r.supported, false);
  assert.equal(r.source, 'dns');
  assert.equal(r.inUse, true);
  const free = await checkDomain({ domain: 'home.example.com', provider: 'ovh', credentials: {}, serverIp: '192.168.1.5', lookupFn: async () => [] });
  assert.equal(free.inUse, false);
});

test('apex of a zone: empty relative names where the API wants them', async () => {
  const f = fakeFetch({
    'GET /dnszone': () => [200, { Items: [{ Id: 7, Domain: 'example.com', Records: [] }] }],
    'PUT /dnszone/7/records': () => [201, {}],
  });
  await upsertRecord({ domain: 'example.com', provider: 'bunny', credentials: { access_key: 'K' }, ip: '10.0.0.2', fetchFn: f });
  assert.deepEqual(f.calls.filter((c) => c.key.startsWith('PUT')).map((c) => c.body.Name), ['*', '']);
});
