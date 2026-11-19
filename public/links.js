// Addresses for the "Open app" button and the Addresses card.

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/**
 * The host for links to published ports (http://<host>:<port>).
 * Opened by IP: that IP. Opened by a name (e.g. the panel's own domain): the server's address,
 * because the name may only work through Caddy and browsers often force https for it.
 */
export function portHost(hostname, serverIp) {
  const h = String(hostname || '');
  if (isIp(h)) return h.includes(':') ? `[${h}]` : h;
  return serverIp || h;
}

/** Links for a stack: its subdomains when it has any, otherwise its published ports. */
export function openTargets({ domain, routes, containers, hostname, serverIp }) {
  if (domain && routes?.length) {
    return [...new Set(routes.map((r) => `https://${r.subdomain}.${domain}`))];
  }
  const host = portHost(hostname, serverIp);
  const urls = [];
  for (const c of containers || []) {
    for (const p of c.ports || []) {
      const m = /^(\d+)→(\d+)\/tcp$/.exec(p);
      if (!m) continue;
      const scheme = m[2] === '443' ? 'https' : 'http';
      urls.push(`${scheme}://${host}:${m[1]}`);
    }
  }
  return [...new Set(urls)];
}

/**
 * The setup code from a link like http://192.168.1.10:5001/#setup=K7QM-4XWD-9TPA (printed by
 * the installer). After "#" so the browser never sends it to the server or any proxy logs.
 */
export function setupCodeFromHash(hash) {
  const m = /^#setup=([A-Za-z0-9-]{1,40})$/.exec(String(hash || ''));
  return m ? m[1] : null;
}
