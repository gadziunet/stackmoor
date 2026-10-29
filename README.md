<p align="center"><img src="assets/banner.png" alt="Moorline – Docker Compose stacks without thinking about volume paths" width="100%"></p>

# Moorline

A simple web UI for Docker Compose stacks – in the spirit of Dockge, but you never have to think about volume paths. Every stack keeps its data in its own folder, ready for backups.

[Polski](README.pl.md)

> **Status:** early development (v0.1). Works for managing stacks; backups, local domains and the setup wizard are on the roadmap.

## Install

On a clean Debian, Ubuntu or Raspberry Pi OS machine (x86_64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/gadziunet/moorline/main/install.sh | sudo bash
```

The script installs Docker if it's missing, starts Moorline and prints its address, e.g. `http://192.168.1.50:5001`. On first visit you create the administrator account.

Run the same command again to update. Optional settings: `curl ... | sudo PORT=8080 STACKS_DIR=/srv/stacks bash`.

> Moorline has access to the Docker socket, which means full control over the machine. Keep it on your local network or behind a VPN.

## Features

- list of stacks with live status
- create a stack by pasting a `compose.yaml` (+ optional `.env`)
- editor with validation through `docker compose config` – a broken file is never saved
- Start, Restart, Update (pull + up), Stop, Shut down – with live output
- live logs, containers with ports, operation history
- deleting a stack moves its folder to `.trash/` – nothing is lost by accident
- English and Polish interface

## Automatic volumes

You don't type host paths. Each stack lives in `/opt/stacks/<name>/` and its data in `/opt/stacks/<name>/data/`:

| In your compose | After saving |
|---|---|
| `- /config` | `- ./data/app-config:/config` |
| `- /some/host/path:/config` | `- ./data/app-config:/config` |
| `- db_data:/var/lib/mysql` | `- ./data/db_data:/var/lib/mysql` |
| nothing, but the image has `VOLUME /data` | `- ./data/app-data:/data` added on start |

Left untouched: system paths (`docker.sock`, `/dev`, `/etc/localtime`…), host paths on the allow-list in Settings (default `/mnt`, `/media` – e.g. media drives, not backed up), paths with `${VARIABLES}`, relative paths inside the stack and `external` volumes.

After saving, the panel shows exactly what it changed. Folders are created before start with owner `PUID:PGID` (default 1000:1000) so they don't end up owned by root. If an app mounts a single **file** (e.g. `nginx.conf`), the panel won't start the stack without it, because Docker would create an empty folder in its place.

Automatic volumes can be turned off per stack.

## Local domains

Give every stack an address like `cloud.home.example.com` with a real HTTPS certificate – no ports to remember, and the server does not have to be reachable from the internet.

1. **Settings → Domains:** enter your domain, pick your DNS provider (Cloudflare, Bunny, OVHcloud, Hetzner, DigitalOcean, Porkbun, Namecheap, GoDaddy, IONOS, netcup, Gandi, AWS Route 53, deSEC, DuckDNS) and paste its API key. Keys are stored encrypted.
2. In your DNS create an A record `*.home.example.com` → the server's IP (a local IP is fine).
3. **Stack → Domain:** choose a subdomain, the service and its port inside the container.

Moorline runs Caddy in its own container (`moorline-caddy`) with one wildcard certificate for all apps. The DNS provider can be changed any time in Settings. On Unraid, ports 80/443 are used by its web UI – choose other ports under *Advanced*.

## Roadmap

- [x] Stacks, editor, automatic volumes, logs
- [x] Local domains through Caddy – wildcard certificate via your DNS provider's API (14 providers) or an internal CA
- [ ] Cloudron-style backups – per stack, automatically before updates, database dumps, schedule, retention, encryption; restic to S3 / Backblaze B2; restore and clone
- [ ] Setup wizard: fresh install or restore everything from a backup
- [ ] Updates: check for new Moorline versions and new stack images (on/off in Settings), show what is new and update only after confirmation

## Development

```bash
npm install
STACKS_DIR=$HOME/stacks npm run dev   # http://localhost:5001
npm test
```

Requires Node 20+ and `docker` with the `compose` plugin. Or with Docker: `docker compose up -d --build` (set `STACKS_DIR` in `.env`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5001` | panel port |
| `STACKS_DIR` | `/opt/stacks` | stacks folder (must be mounted at the same path in the container) |
| `DATA_DIR` | `./data` (`/app/data` in the image) | panel database (SQLite) |

```
src/
  server.js    – Express, API, sessions
  db.js        – SQLite (better-sqlite3, WAL), migrations, settings
  auth.js      – passwords (scrypt), sessions, login rate limit
  stacks.js    – stack operations, running docker compose
  compose.js   – automatic volumes (YAML rewrite that keeps comments)
  i18n.js      – server messages (en, pl)
public/        – UI (plain JS, no build step), i18n.js for UI texts
install.sh     – installer / updater
```

Translations: add a language block to `src/i18n.js` and `public/i18n.js` – tests check that every language has all keys.

## How it's made

Moorline is written with the help of AI – [Claude](https://claude.ai) by Anthropic. I design the features, review the changes and test every release myself on real servers (Debian and Unraid) before publishing it. The code is covered by automated tests that run on every push.

If you find a bug, please [open an issue](https://github.com/gadziunet/moorline/issues).

## License

[AGPL-3.0](LICENSE) © Gadziunet. You may use, modify and share Moorline freely; if you distribute a modified version or offer it as a network service, you must publish your changes under the same license.
