# Caddy with the DNS provider plugins Stackmoor offers (see src/dns-providers.js).
# Cross-compiled on the build machine for each target platform (fast, no emulation).
ARG CADDY_VERSION=2.11

FROM --platform=$BUILDPLATFORM caddy:${CADDY_VERSION}-builder AS builder
ARG TARGETOS
ARG TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH xcaddy build \
      --with github.com/caddy-dns/cloudflare \
      --with github.com/caddy-dns/bunny \
      --with github.com/caddy-dns/ovh \
      --with github.com/caddy-dns/hetzner/v2 \
      --with github.com/caddy-dns/digitalocean \
      --with github.com/caddy-dns/porkbun \
      --with github.com/caddy-dns/namecheap \
      --with github.com/caddy-dns/godaddy \
      --with github.com/caddy-dns/ionos \
      --with github.com/caddy-dns/netcup \
      --with github.com/caddy-dns/gandi \
      --with github.com/caddy-dns/route53 \
      --with github.com/caddy-dns/desec \
      --with github.com/caddy-dns/duckdns

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Allow binding ports 80/443 without full root capabilities.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy

LABEL org.opencontainers.image.title="stackmoor-caddy" \
      org.opencontainers.image.description="Caddy with DNS provider plugins, used by Stackmoor for local domains" \
      org.opencontainers.image.licenses="Apache-2.0"

CMD ["caddy", "run", "--config", "/etc/caddy/caddy.json"]
