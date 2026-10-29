// DNS providers built into the moorline-caddy image (see caddy/Dockerfile).
// Each entry maps the panel's form fields to the JSON of the matching caddy-dns module.
// To add a provider: add it here AND to caddy/Dockerfile, then release a new version.

const f = (key, label, opts = {}) => ({ key, label, secret: false, required: true, ...opts });
const secret = (key, label, opts = {}) => f(key, label, { secret: true, ...opts });

export const PROVIDERS = [
  {
    id: 'cloudflare', name: 'Cloudflare', module: 'github.com/caddy-dns/cloudflare',
    fields: [secret('api_token', 'API token')],
    help: {
      en: 'Cloudflare dashboard → My Profile → API Tokens → Create token with Zone:Read and Zone:DNS:Edit for your domain.',
      pl: 'Panel Cloudflare → My Profile → API Tokens → utwórz token z uprawnieniami Zone:Read i Zone:DNS:Edit dla swojej domeny.',
    },
  },
  {
    id: 'bunny', name: 'Bunny DNS', module: 'github.com/caddy-dns/bunny',
    fields: [secret('access_key', 'API key')],
    help: {
      en: 'dash.bunny.net → Account settings → API key.',
      pl: 'dash.bunny.net → Account settings → API key.',
    },
  },
  {
    id: 'ovh', name: 'OVHcloud', module: 'github.com/caddy-dns/ovh',
    fields: [
      f('endpoint', 'Endpoint', { default: 'ovh-eu', placeholder: 'ovh-eu' }),
      f('application_key', 'Application key'),
      secret('application_secret', 'Application secret'),
      secret('consumer_key', 'Consumer key'),
    ],
    help: {
      en: 'Create script credentials at api.ovh.com/createToken with GET/POST/PUT/DELETE on /domain/zone/*/record*, GET /domain/zone/*/soa and POST /domain/zone/*/refresh. Europe: endpoint ovh-eu.',
      pl: 'Utwórz klucze na api.ovh.com/createToken z prawami GET/POST/PUT/DELETE do /domain/zone/*/record*, GET /domain/zone/*/soa i POST /domain/zone/*/refresh. Europa: endpoint ovh-eu.',
    },
  },
  {
    id: 'hetzner', name: 'Hetzner', module: 'github.com/caddy-dns/hetzner/v2',
    fields: [secret('api_token', 'API token')],
    help: {
      en: 'Hetzner Console → your project → Security → API tokens → read & write. (Uses the new Hetzner Cloud DNS API.)',
      pl: 'Hetzner Console → projekt → Security → API tokens → odczyt i zapis. (Nowe API DNS Hetzner Cloud.)',
    },
  },
  {
    id: 'digitalocean', name: 'DigitalOcean', module: 'github.com/caddy-dns/digitalocean',
    fields: [secret('auth_token', 'Personal access token')],
    help: {
      en: 'DigitalOcean control panel → API → Generate new token with write access.',
      pl: 'Panel DigitalOcean → API → Generate new token z prawem zapisu.',
    },
  },
  {
    id: 'porkbun', name: 'Porkbun', module: 'github.com/caddy-dns/porkbun',
    fields: [f('api_key', 'API key'), secret('api_secret_key', 'Secret API key')],
    help: {
      en: 'porkbun.com → Account → API Access, then turn on “API Access” for the domain.',
      pl: 'porkbun.com → Account → API Access, a potem włącz „API Access” przy domenie.',
    },
  },
  {
    id: 'namecheap', name: 'Namecheap', module: 'github.com/caddy-dns/namecheap',
    fields: [f('user', 'API user'), secret('api_key', 'API key')],
    help: {
      en: 'Namecheap → Profile → Tools → API Access: enable it and whitelist this server’s public IP address.',
      pl: 'Namecheap → Profile → Tools → API Access: włącz i dodaj do białej listy publiczny adres IP tego serwera.',
    },
  },
  {
    id: 'godaddy', name: 'GoDaddy', module: 'github.com/caddy-dns/godaddy',
    fields: [f('key', 'API key'), secret('secret', 'API secret')],
    toJson: (v) => ({ api_token: `${v.key}:${v.secret}` }),
    help: {
      en: 'developer.godaddy.com → API Keys → create a Production key.',
      pl: 'developer.godaddy.com → API Keys → utwórz klucz Production.',
    },
  },
  {
    id: 'ionos', name: 'IONOS', module: 'github.com/caddy-dns/ionos',
    fields: [secret('api_token', 'API key (prefix.secret)')],
    help: {
      en: 'developer.hosting.ionos.de → API keys. Enter it as publicprefix.secret.',
      pl: 'developer.hosting.ionos.de → API keys. Wpisz w formacie publicprefix.secret.',
    },
  },
  {
    id: 'netcup', name: 'netcup', module: 'github.com/caddy-dns/netcup',
    fields: [f('customer_number', 'Customer number'), secret('api_key', 'API key'), secret('api_password', 'API password')],
    propagationDelay: '900s', // netcup DNS is slow to publish changes
    help: {
      en: 'netcup CCP → Master data (Stammdaten) → API. The first certificate can take ~15 minutes.',
      pl: 'netcup CCP → Stammdaten → API. Pierwszy certyfikat może trwać ok. 15 minut.',
    },
  },
  {
    id: 'gandi', name: 'Gandi', module: 'github.com/caddy-dns/gandi',
    fields: [secret('bearer_token', 'Personal access token')],
    help: {
      en: 'account.gandi.net → Personal Access Tokens → with LiveDNS rights for your domain.',
      pl: 'account.gandi.net → Personal Access Tokens → z uprawnieniami LiveDNS dla domeny.',
    },
  },
  {
    id: 'route53', name: 'AWS Route 53', module: 'github.com/caddy-dns/route53',
    fields: [
      f('access_key_id', 'Access key ID'),
      secret('secret_access_key', 'Secret access key'),
      f('hosted_zone_id', 'Hosted zone ID', { required: false }),
    ],
    help: {
      en: 'AWS IAM → user with Route 53 permissions to list zones and change records in your hosted zone.',
      pl: 'AWS IAM → użytkownik z uprawnieniami Route 53 do listowania stref i zmiany rekordów w Twojej strefie.',
    },
  },
  {
    id: 'desec', name: 'deSEC', module: 'github.com/caddy-dns/desec',
    fields: [secret('token', 'Token')],
    help: {
      en: 'desec.io → Token management → create a token.',
      pl: 'desec.io → Token management → utwórz token.',
    },
  },
  {
    id: 'duckdns', name: 'DuckDNS', module: 'github.com/caddy-dns/duckdns',
    fields: [secret('api_token', 'Token')],
    help: {
      en: 'Shown at the top of duckdns.org after you log in. Use your duckdns.org subdomain as the domain, e.g. myhome.duckdns.org.',
      pl: 'Widoczny na górze duckdns.org po zalogowaniu. Jako domenę wpisz swoją subdomenę, np. mojdom.duckdns.org.',
    },
  },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

/** The "provider" object for Caddy's DNS challenge config. */
export function providerJson(id, values) {
  const p = providerById(id);
  if (!p) return null;
  const v = {};
  for (const field of p.fields) if (values?.[field.key]) v[field.key] = values[field.key];
  return { name: p.id, ...(p.toJson ? p.toJson(v) : v) };
}
