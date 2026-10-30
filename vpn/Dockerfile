# WireGuard client used by Stackmoor's "Connect through VPN" (see src/vpn.js).
# Chosen services of a stack share this container's network, so their traffic leaves
# through the tunnel. A kill switch (written by the panel) blocks everything else.
FROM alpine:3.20
RUN apk add --no-cache bash iproute2 iptables ip6tables wireguard-tools
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

LABEL org.opencontainers.image.title="stackmoor-vpn" \
      org.opencontainers.image.description="WireGuard client with a kill switch, used by Stackmoor" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Healthy = the tunnel had a handshake in the last 3 minutes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD \
  bash -c 't=$(wg show wg0 latest-handshakes 2>/dev/null | awk "{print \$2}" | sort -n | tail -1); [ -n "$t" ] && [ $(( $(date +%s) - t )) -lt 180 ]'

ENTRYPOINT ["/entrypoint.sh"]
