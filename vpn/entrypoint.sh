#!/bin/bash
# Starts the kill switch first, then the tunnel, and keeps the tunnel up.
set -uo pipefail
CONF=/etc/wireguard/wg0.conf
RULES=/etc/wireguard/killswitch.sh
ROUTES=/etc/wireguard/routes.sh
# Local networks the normal way (written by the panel), after the tunnel is up.
local_routes() { [ -f "$ROUTES" ] && bash "$ROUTES" && echo "Local networks go the normal way."; return 0; }

[ -f "$CONF" ] || { echo "Missing $CONF"; exit 1; }

# 1. Kill switch: nothing leaves this container except through the tunnel
#    (and to the local network). Applied before the tunnel exists, so there is no gap.
if ! bash "$RULES"; then
  echo "Could not set up the kill switch – not starting the tunnel."
  exit 1
fi
echo "Kill switch on."

down() { echo "Stopping the tunnel."; wg-quick down wg0 >/dev/null 2>&1; exit 0; }
trap down TERM INT

# 2. Tunnel. Retry until it comes up (e.g. the server starts before the network is ready).
until wg-quick up wg0; do
  echo "Tunnel did not start – trying again in 15 s."
  sleep 15 & wait $!
done
echo "Tunnel up."
local_routes

# 3. Bring it back if the interface disappears.
while true; do
  sleep 30 & wait $!
  if ! ip link show wg0 >/dev/null 2>&1; then
    echo "Tunnel interface is gone – starting it again."
    wg-quick up wg0 && local_routes
  fi
done
