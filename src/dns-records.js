// The local DNS record for the domain: *.<domain> → this server's IP address.
// Caddy only uses the DNS provider for certificates (TXT records); this module adds the
// A record itself, so nobody has to do it by hand in the provider's dashboard.
// Supported providers below; for the others the panel shows what to add manually.

import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';

const TIMEOUT = 15_000;
const TTL = 300;

/** A problem talking to the provider. kind: auth | zone | network | api */
export class DnsApiError extends Error {
  constructor(kind, message = '') {
    super(message || kind);
    this.kind = kind;
  }
}

/** "home.example.com" → ["home.example.com", "example.com"] (longest first). */
export function zoneCandidates(domain) {
  const labels = String(domain).toLowerCase().split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** The record name relative to its zone: ("*.home.example.com", "example.com") → "*.home". */
export function relativeName(fqdn, zone) {
  if (fqdn === zone) return '@';
  return fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -(zone.length + 1)) : fqdn;
}

async function call(fetchFn, url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetchFn(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    throw new DnsApiError('network', err.message);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) throw new DnsApiError('auth', `HTTP ${res.status}`);
  return { status: res.status, ok: res.ok, json, text };
}

const apiFail = (r) => new DnsApiError('api', `HTTP ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : ''}`);

// Each client: zone(domain) → zone name (throws 'zone' when none fits),
// get(zone, fqdn) → [ips], set(zone, fqdn, ip) → 'created' | 'updated'.
const CLIENTS = {
  cloudflare(c, fetchFn) {
    const base = 'https://api.cloudflare.com/client/v4';
    const headers = { Authorization: `Bearer ${c.api_token}` };
    const ids = new Map();
    const records = async (zone, fqdn) => {
      const r = await call(fetchFn, `${base}/zones/${ids.get(zone)}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`, { headers });
      if (!r.ok || !r.json?.success) throw apiFail(r);
      return r.json.result || [];
    };
    return {
      async zone(domain) {
        for (const name of zoneCandidates(domain)) {
          const r = await call(fetchFn, `${base}/zones?name=${encodeURIComponent(name)}`, { headers });
          if (!r.ok || !r.json?.success) throw apiFail(r);
          const z = r.json.result?.[0];
          if (z) { ids.set(name, z.id); return name; }
        }
        throw new DnsApiError('zone');
      },
      async get(zone, fqdn) { return (await records(zone, fqdn)).map((x) => x.content); },
      async set(zone, fqdn, ip) {
        const [first] = await records(zone, fqdn);
        const r = first
          ? await call(fetchFn, `${base}/zones/${ids.get(zone)}/dns_records/${first.id}`, { method: 'PATCH', headers, body: { content: ip } })
          : await call(fetchFn, `${base}/zones/${ids.get(zone)}/dns_records`, { method: 'POST', headers, body: { type: 'A', name: fqdn, content: ip, ttl: 1, proxied: false } });
        if (!r.ok || !r.json?.success) throw apiFail(r);
        return first ? 'updated' : 'created';
      },
    };
  },

  bunny(c, fetchFn) {
    const base = 'https://api.bunny.net';
    const headers = { AccessKey: c.access_key };
    const zones = new Map();
    const load = async () => {
      const r = await call(fetchFn, `${base}/dnszone?page=1&perPage=1000`, { headers });
      if (!r.ok) throw apiFail(r);
      for (const z of r.json?.Items || []) zones.set(String(z.Domain).toLowerCase(), z);
    };
    const find = (zone, fqdn) => (zones.get(zone)?.Records || [])
      .filter((x) => x.Type === 0 && String(x.Name).toLowerCase() === relativeName(fqdn, zone).replace(/^@$/, ''));
    return {
      async zone(domain) {
        await load();
        const name = zoneCandidates(domain).find((n) => zones.has(n));
        if (!name) throw new DnsApiError('zone');
        return name;
      },
      async get(zone, fqdn) { return find(zone, fqdn).map((x) => x.Value); },
      async set(zone, fqdn, ip) {
        const z = zones.get(zone);
        const [first] = find(zone, fqdn);
        const name = relativeName(fqdn, zone).replace(/^@$/, '');
        const r = first
          ? await call(fetchFn, `${base}/dnszone/${z.Id}/records/${first.Id}`, { method: 'POST', headers, body: { Id: first.Id, Type: 0, Name: name, Value: ip, Ttl: TTL } })
          : await call(fetchFn, `${base}/dnszone/${z.Id}/records`, { method: 'PUT', headers, body: { Type: 0, Name: name, Value: ip, Ttl: TTL } });
        if (!r.ok) throw apiFail(r);
        return first ? 'updated' : 'created';
      },
    };
  },

  hetzner(c, fetchFn) {
    const base = 'https://api.hetzner.cloud/v1';
    const headers = { Authorization: `Bearer ${c.api_token}` };
    const ids = new Map();
    const rrset = (zone, fqdn) => `${base}/zones/${ids.get(zone)}/rrsets/${encodeURIComponent(relativeName(fqdn, zone))}/A`;
    return {
      async zone(domain) {
        for (const name of zoneCandidates(domain)) {
          const r = await call(fetchFn, `${base}/zones?name=${encodeURIComponent(name)}`, { headers });
          if (!r.ok) throw apiFail(r);
          const z = r.json?.zones?.[0];
          if (z) { ids.set(name, z.id); return name; }
        }
        throw new DnsApiError('zone');
      },
      async get(zone, fqdn) {
        const r = await call(fetchFn, rrset(zone, fqdn), { headers });
        if (r.status === 404) return [];
        if (!r.ok) throw apiFail(r);
        return (r.json?.rrset?.records || []).map((x) => x.value);
      },
      async set(zone, fqdn, ip) {
        const exists = (await this.get(zone, fqdn)).length > 0;
        const r = exists
          ? await call(fetchFn, `${rrset(zone, fqdn)}/actions/set_records`, { method: 'POST', headers, body: { records: [{ value: ip }] } })
          : await call(fetchFn, `${base}/zones/${ids.get(zone)}/rrsets`, { method: 'POST', headers, body: { name: relativeName(fqdn, zone), type: 'A', ttl: TTL, records: [{ value: ip }] } });
        if (!r.ok) throw apiFail(r);
        return exists ? 'updated' : 'created';
      },
    };
  },

  desec(c, fetchFn) {
    const base = 'https://desec.io/api/v1';
    const headers = { Authorization: `Token ${c.token}` };
    return {
      async zone(domain) {
        const r = await call(fetchFn, `${base}/domains/`, { headers });
        if (!r.ok) throw apiFail(r);
        const names = new Set((r.json || []).map((d) => String(d.name).toLowerCase()));
        const name = zoneCandidates(domain).find((n) => names.has(n));
        if (!name) throw new DnsApiError('zone');
        return name;
      },
      async get(zone, fqdn) {
        const sub = relativeName(fqdn, zone).replace(/^@$/, '');
        const r = await call(fetchFn, `${base}/domains/${zone}/rrsets/${encodeURIComponent(sub)}/A/`, { headers });
        if (r.status === 404) return [];
        if (!r.ok) throw apiFail(r);
        return r.json?.records || [];
      },
      async set(zone, fqdn, ip) {
        const had = (await this.get(zone, fqdn)).length > 0;
        const subname = relativeName(fqdn, zone).replace(/^@$/, '');
        // Bulk PUT creates the record set or replaces it. deSEC's minimum TTL is 3600.
        const r = await call(fetchFn, `${base}/domains/${zone}/rrsets/`, { method: 'PUT', headers, body: [{ subname, type: 'A', ttl: 3600, records: [ip] }] });
        if (!r.ok) throw apiFail(r);
        return had ? 'updated' : 'created';
      },
    };
  },

  digitalocean(c, fetchFn) {
    const base = 'https://api.digitalocean.com/v2';
    const headers = { Authorization: `Bearer ${c.auth_token}` };
    const records = async (zone, fqdn) => {
      const r = await call(fetchFn, `${base}/domains/${zone}/records?type=A&name=${encodeURIComponent(fqdn)}`, { headers });
      if (!r.ok) throw apiFail(r);
      return r.json?.domain_records || [];
    };
    return {
      async zone(domain) {
        for (const name of zoneCandidates(domain)) {
          const r = await call(fetchFn, `${base}/domains/${name}`, { headers });
          if (r.ok) return name;
          if (r.status !== 404) throw apiFail(r);
        }
        throw new DnsApiError('zone');
      },
      async get(zone, fqdn) { return (await records(zone, fqdn)).map((x) => x.data); },
      async set(zone, fqdn, ip) {
        const [first] = await records(zone, fqdn);
        const r = first
          ? await call(fetchFn, `${base}/domains/${zone}/records/${first.id}`, { method: 'PATCH', headers, body: { data: ip } })
          : await call(fetchFn, `${base}/domains/${zone}/records`, { method: 'POST', headers, body: { type: 'A', name: relativeName(fqdn, zone), data: ip, ttl: TTL } });
        if (!r.ok) throw apiFail(r);
        return first ? 'updated' : 'created';
      },
    };
  },

  porkbun(c, fetchFn) {
    const base = 'https://api.porkbun.com/api/json/v3';
    const keys = { apikey: c.api_key, secretapikey: c.api_secret_key };
    const post = async (p, body = {}) => {
      const r = await call(fetchFn, `${base}${p}`, { method: 'POST', body: { ...keys, ...body } });
      if (r.json?.status === 'ERROR' && /invalid api key/i.test(r.json?.message || '')) throw new DnsApiError('auth', r.json.message);
      return r;
    };
    return {
      async zone(domain) {
        for (const name of zoneCandidates(domain)) {
          const r = await post(`/dns/retrieve/${name}`);
          if (r.ok && r.json?.status === 'SUCCESS') return name;
        }
        throw new DnsApiError('zone');
      },
      async get(zone, fqdn) {
        const sub = relativeName(fqdn, zone).replace(/^@$/, '');
        const r = await post(`/dns/retrieveByNameType/${zone}/A/${sub}`);
        if (!r.ok || r.json?.status !== 'SUCCESS') throw apiFail(r);
        return (r.json.records || []).map((x) => x.content);
      },
      async set(zone, fqdn, ip) {
        const sub = relativeName(fqdn, zone).replace(/^@$/, '');
        const had = (await this.get(zone, fqdn)).length > 0;
        const r = had
          ? await post(`/dns/editByNameType/${zone}/A/${sub}`, { content: ip, ttl: String(TTL) })
          : await post(`/dns/create/${zone}`, { name: sub, type: 'A', content: ip, ttl: String(TTL) });
        if (!r.ok || r.json?.status !== 'SUCCESS') throw apiFail(r);
        return had ? 'updated' : 'created';
      },
    };
  },

  // DuckDNS: one name per account entry; it answers for every name below it as well.
  duckdns(c, fetchFn) {
    const sub = (zone) => zone.replace(/\.duckdns\.org$/, '');
    return {
      async zone(domain) {
        const m = String(domain).toLowerCase().match(/([a-z0-9-]+)\.duckdns\.org$/);
        if (!m) throw new DnsApiError('zone');
        return `${m[1]}.duckdns.org`;
      },
      async get(zone) { return lookup(`${zone}`); },
      async set(zone, _fqdn, ip) {
        const r = await call(fetchFn, `https://www.duckdns.org/update?domains=${encodeURIComponent(sub(zone))}&token=${encodeURIComponent(c.api_token)}&ip=${encodeURIComponent(ip)}`);
        if (r.text.trim() !== 'OK') throw new DnsApiError('auth', r.text.trim());
        return 'updated';
      },
    };
  },
};

export const AUTO_RECORD_PROVIDERS = Object.keys(CLIENTS);
export const supportsAutoRecord = (provider) => AUTO_RECORD_PROVIDERS.includes(provider);

/** What public DNS currently says for names under the domain (any name – the wildcard answers). */
export async function lookup(name, servers = ['1.1.1.1', '8.8.8.8']) {
  const r = new Resolver({ timeout: 2500, tries: 1 });
  r.setServers(servers);
  try {
    return await r.resolve4(name);
  } catch {
    return [];
  }
}

/** A random name under the domain, answered by *.domain if that exists. */
export const probeName = (domain) => `stackmoor-check-${randomBytes(4).toString('hex')}.${domain}`;

/** The names the panel manages: the domain itself and every name under it. */
export const recordNames = (domain) => [`*.${domain}`, domain];

/**
 * Before saving: can we use the provider's API, and do the domain or *.domain already
 * point somewhere? Never changes anything.
 */
export async function checkDomain({ domain, provider, credentials, serverIp, fetchFn = fetch, lookupFn = lookup }) {
  const out = { supported: supportsAutoRecord(provider), api: null, zone: null, existing: [], records: {}, source: 'dns' };
  if (out.supported && provider !== 'duckdns') {
    try {
      const client = CLIENTS[provider](credentials || {}, fetchFn);
      out.zone = await client.zone(domain);
      for (const name of recordNames(domain)) out.records[name] = await client.get(out.zone, name);
      out.source = 'api';
      out.api = { ok: true };
    } catch (err) {
      out.api = { ok: false, kind: err.kind || 'api', message: err.message };
    }
  }
  if (out.source === 'dns') {
    out.records = { [`*.${domain}`]: await lookupFn(probeName(domain)), [domain]: await lookupFn(domain) };
  }
  out.existing = [...new Set(Object.values(out.records).flat())];
  out.inUse = out.existing.length > 0 && !(serverIp && out.existing.every((ip) => ip === serverIp));
  return out;
}

/**
 * Creates or updates the domain and *.domain → ip.
 * Returns { action, zone, names } – action: 'created' | 'updated' | 'unchanged' (the "biggest" change).
 */
export async function upsertRecord({ domain, provider, credentials, ip, fetchFn = fetch }) {
  if (!supportsAutoRecord(provider)) throw new DnsApiError('unsupported');
  const client = CLIENTS[provider](credentials || {}, fetchFn);
  const zone = await client.zone(domain);
  // DuckDNS has one address per name and answers for everything below it.
  if (provider === 'duckdns') return { action: await client.set(zone, domain, ip), zone, names: recordNames(domain) };
  const rank = { unchanged: 0, updated: 1, created: 2 };
  let action = 'unchanged';
  for (const name of recordNames(domain)) {
    const now = await client.get(zone, name);
    const a = now.length === 1 && now[0] === ip ? 'unchanged' : await client.set(zone, name, ip);
    if (rank[a] > rank[action]) action = a;
  }
  return { action, zone, names: recordNames(domain) };
}

export const isIPv4 = (v) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(v || ''));
export const isPrivateIPv4 = (v) => isIPv4(v)
  && (/^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v));
