#!/bin/sh
# Run as root after uploading the image and backing up the v1 configuration.
set -eu
cd /opt/watchpair-v2
test -s downloads/watchpair-windows-x64.zip
test -s downloads/watchpair-linux-x64.tar.gz
test -s downloads/release.json
test -s Caddyfile
docker image inspect watchpair-v2:2.0.0-alpha.2 >/dev/null
test -s backup-v1.tar.gz
install -d -o 1000 -g 1000 -m 700 data
if [ ! -s service.env ]; then
  umask 077
  {
    printf 'WATCHPAIR_RELAY_SECRET='
    openssl rand -base64 32
    printf 'WATCHPAIR_RELAY_URL=https://38-180-216-137.sslip.io:8443\n'
  } > service.env
fi
chmod 600 service.env
docker run -d --init --name watchpair-v2-coordinator --network watchpair-net \
  --restart unless-stopped --memory 192m --memory-swap 192m --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --log-opt max-size=5m --log-opt max-file=2 \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:8787/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  --health-interval 30s --health-timeout 3s --health-retries 3 \
  --env-file service.env -e NODE_OPTIONS=--max-old-space-size=112 \
  -e HOST=0.0.0.0 -e PORT=8787 -e WATCHPAIR_TRUST_PROXY=true \
  -e WATCHPAIR_DATABASE=/data/watchpair-v2.sqlite \
  -v /opt/watchpair-v2/data:/data watchpair-v2:2.0.0-alpha.2
docker run -d --init --name watchpair-v2-relay --network watchpair-net \
  --restart unless-stopped --memory 160m --memory-swap 160m --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --log-opt max-size=5m --log-opt max-file=2 \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:8788/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  --health-interval 30s --health-timeout 3s --health-retries 3 \
  --env-file service.env -e NODE_OPTIONS=--max-old-space-size=80 \
  -e WATCHPAIR_RELAY_HOST=0.0.0.0 -e WATCHPAIR_RELAY_PORT=8788 \
  -e WATCHPAIR_RELAY_INGRESS_BPS=2097152 -e WATCHPAIR_RELAY_EGRESS_BPS=2097152 \
  -e WATCHPAIR_RELAY_CHANNEL_INGRESS_BPS=1048576 -e WATCHPAIR_RELAY_CHANNEL_EGRESS_BPS=1048576 \
  -e WATCHPAIR_RELAY_BUFFER_BYTES=16777216 -e WATCHPAIR_RELAY_MAX_CHANNELS=128 \
  watchpair-v2:2.0.0-alpha.2 node dist/src/relay-main.js
for service in watchpair-v2-coordinator watchpair-v2-relay; do
  for attempt in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$service")" = healthy ]; then break; fi
    sleep 2
  done
  test "$(docker inspect -f '{{.State.Health.Status}}' "$service")" = healthy
done
docker run --rm --network watchpair-net \
  -v /opt/watchpair-v2/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
printf '%s\n' 'V2 services healthy; proxy cutover is a separate step.'
