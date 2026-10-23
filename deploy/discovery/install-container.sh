#!/usr/bin/env bash
set -euo pipefail
root=/opt/rightdata/discovery
config=/opt/1panel/apps/openresty/openresty/conf/conf.d
proxy=1Panel-openresty-s5cK
image=node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
test "$(id -u)" = 0
test -f "$root/server.mjs"
test -f "$config/bollmonitor.conf"
docker image inspect "$image" >/dev/null
docker exec "$proxy" nginx -t
install -d -m 755 "$root/deployment"
if [ ! -f "$root/deployment/bollmonitor.conf.before-discovery" ]; then
    cp -p "$config/bollmonitor.conf" "$root/deployment/bollmonitor.conf.before-discovery"
fi
cp -p "$config/bollmonitor.conf" "$root/deployment/bollmonitor.conf.before-update"
printf 'DISCOVERY_IMAGE=%s\n' "$image" > "$root/image.env"
chmod 644 "$root/server.mjs" "$root/image.env"
install -m 644 "$root/rightdata-discovery-container.service" /etc/systemd/system/rightdata-discovery.service
systemctl daemon-reload
systemctl enable rightdata-discovery
systemctl restart rightdata-discovery
for attempt in $(seq 1 20); do
    if curl -fsS --max-time 2 http://127.0.0.1:18090/healthz > "$root/deployment/health.json" 2>/dev/null; then break; fi
    sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:18090/healthz
install -m 644 "$root/nginx-locations.inc" "$config/rightdata-discovery-locations.inc"
python3 - "$config/bollmonitor.conf" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
include = '    include /usr/local/openresty/nginx/conf/conf.d/rightdata-discovery-locations.inc;'
if include not in text:
    if text.count('server {') != 1:
        raise SystemExit('Expected exactly one existing HTTPS server block')
    path.write_text(text.replace('server {', 'server {\n' + include, 1))
PY
if ! docker exec "$proxy" nginx -t; then
    cp -p "$root/deployment/bollmonitor.conf.before-update" "$config/bollmonitor.conf"
    exit 1
fi
docker exec "$proxy" nginx -s reload
for attempt in $(seq 1 10); do
    if curl -fsS --max-time 5 https://39.106.128.14/rightdata-discovery/healthz | python3 -c 'import json,sys; assert json.load(sys.stdin)=={"status":"ok"}' 2>/dev/null; then break; fi
    sleep 1
done
curl -fsS --max-time 10 https://39.106.128.14/rightdata-discovery/healthz | python3 -c 'import json,sys; assert json.load(sys.stdin)=={"status":"ok"}; print("HTTPS discovery health verified")'
systemctl is-active rightdata-discovery
systemctl is-enabled rightdata-discovery
