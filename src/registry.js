// Reads the current digest of an image tag straight from its registry (Docker Hub, GHCR,
// lscr.io, quay.io, ...) using the standard Registry v2 API. HEAD requests do not count
// against Docker Hub pull limits. Private registries that need credentials are skipped.

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

/** "nginx:alpine" -> { registry: 'docker.io', repo: 'library/nginx', tag: 'alpine', key: 'docker.io/library/nginx' } */
export function parseImageRef(ref) {
  let name = String(ref || '').trim();
  if (!name) return null;
  if (name.includes('@')) return { pinned: true, ref: name };

  let tag = 'latest';
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  if (colon > slash) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }

  const parts = name.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  let repo = parts.join('/');
  if (registry === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  return { registry, repo, tag, key: `${registry}/${repo}`.toLowerCase() };
}

const apiHost = (registry) => (registry === 'docker.io' ? 'registry-1.docker.io' : registry);

/** Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="..." */
export function parseChallenge(header) {
  const h = String(header || '');
  if (!/^bearer\s/i.test(h)) return null;
  const out = {};
  for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out.realm ? out : null;
}

async function request(url, headers, method = 'HEAD') {
  return fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
}

/** Remote digest for an image tag, or null if it can't be read (private, offline, unknown). */
export async function remoteDigest(ref) {
  const img = parseImageRef(ref);
  if (!img || img.pinned) return null;
  const url = `https://${apiHost(img.registry)}/v2/${img.repo}/manifests/${img.tag}`;
  const headers = { Accept: ACCEPT };

  try {
    let res = await request(url, headers);
    if (res.status === 401) {
      const ch = parseChallenge(res.headers.get('www-authenticate'));
      if (!ch) return null;
      const t = new URL(ch.realm);
      if (ch.service) t.searchParams.set('service', ch.service);
      t.searchParams.set('scope', ch.scope || `repository:${img.repo}:pull`);
      const tokenRes = await fetch(t, { signal: AbortSignal.timeout(15000) });
      if (!tokenRes.ok) return null;
      const body = await tokenRes.json();
      const token = body.token || body.access_token;
      if (!token) return null;
      res = await request(url, { ...headers, Authorization: `Bearer ${token}` });
    }
    if (res.status === 405) res = await request(url, headers, 'GET');
    if (!res.ok) return null;
    return res.headers.get('docker-content-digest');
  } catch {
    return null;
  }
}

/** Digests from `docker image inspect` RepoDigests that belong to the same repository. */
export function localDigests(ref, repoDigests) {
  const img = parseImageRef(ref);
  if (!img || img.pinned) return [];
  return (repoDigests || [])
    .map((d) => {
      const [name, digest] = String(d).split('@');
      const p = parseImageRef(name);
      return p && p.key === img.key ? digest : null;
    })
    .filter(Boolean);
}
