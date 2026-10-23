#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash install.sh.' >&2; exit 1; }
for tool in systemctl openssl useradd install curl sha256sum; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
bash ./preflight.sh
sha256sum --check --quiet SHA256SUMS
[[ ! -e /opt/rightdata/current && ! -e /etc/rightdata/server.env ]] || { echo 'Existing installation found; follow the upgrade procedure in README.md.' >&2; exit 1; }
version=$(sed -n 's/.*"version":"\([0-9][0-9.]*\)".*/\1/p' build.json)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid build version' >&2; exit 1; }
if ! id rightdata >/dev/null 2>&1; then useradd --system --user-group --home-dir /var/lib/rightdata --shell /sbin/nologin rightdata; fi
install -d -m 755 /opt/rightdata "/opt/rightdata/$version"
install -d -m 700 /etc/rightdata
install -d -o rightdata -g rightdata -m 700 /var/lib/rightdata
cp -a ./rightdata ./resource ./build.json "/opt/rightdata/$version/"
chown -R root:root "/opt/rightdata/$version"
chmod -R go-w "/opt/rightdata/$version"
ln -s "/opt/rightdata/$version" /opt/rightdata/current
umask 077
printf 'RIGHTDATA_ADDRESS=0.0.0.0:8003\nRIGHTDATA_DATA_DIR=/var/lib/rightdata\nRIGHTDATA_MASTER_KEY=%s\nRIGHTDATA_COOKIE_SECURE=true\nGF_GCFG_FILE=/etc/rightdata/config.json\n' "$(openssl rand -base64 32)" > /etc/rightdata/server.env
printf '{"server":{"address":"0.0.0.0:8003"}}\n' > /etc/rightdata/config.json
chmod 755 /etc/rightdata
chmod 644 /etc/rightdata/config.json
chmod 600 /etc/rightdata/server.env
install -m 644 rightdata-server.service /etc/systemd/system/rightdata-server.service
systemctl daemon-reload
systemctl enable --now rightdata-server.service
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8003/api/probe | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
    echo 'RightData ready on 0.0.0.0:8003. See README.md to retrieve the initial password and configure firewall access.'
    exit 0
  fi
  sleep 1
done
echo 'Health check failed. Inspect: journalctl -u rightdata-server -n 100. Configuration and data retained.' >&2
exit 1
