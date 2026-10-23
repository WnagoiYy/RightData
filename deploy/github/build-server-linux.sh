#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/go/bin:/opt/python/cp311-cp311/bin:$PATH"
export CGO_ENABLED=1 GOAMD64=v1
export CGO_LDFLAGS='-static-libstdc++ -static-libgcc'
export GOCACHE="$PWD/test/build/go-cache" GOTMPDIR="$PWD/test/runtime/go-build"
export TMPDIR="$PWD/test/runtime"
mkdir -p "$GOCACHE" "$GOTMPDIR" test/artifacts/release
version=$(python3 -c 'import json; print(json.load(open("client/package.json"))["version"])')
stage="$PWD/test/build/server-linux-$version"
mkdir -p "$stage/resource/duckdb/v2.0.0/linux_amd64"
extension="$stage/resource/duckdb/v2.0.0/linux_amd64/httpfs.duckdb_extension"
curl --fail --location --retry 3 --proto '=https' https://extensions.duckdb.org/v2.0.0/linux_amd64/httpfs.duckdb_extension.gz | gzip -d > "$extension"
export RIGHTDATA_DUCKDB_EXTENSION="$extension"
# Test-only ephemeral key, never reused by installed servers.
export RIGHTDATA_MASTER_KEY
RIGHTDATA_MASTER_KEY=$(python3 -c 'import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())')
(cd server && go vet ./... && go build -trimpath -o "$stage/rightdata" .)
(cd test/server && go test -count=1 -timeout=10m ./...)
cp deploy/server/linux/{install.sh,preflight.sh,rightdata-server.service,README.md} "$stage/"
printf '{"version":"%s","commit":"%s","platform":"linux","arch":"x64","glibcMinimum":"2.28"}\n' "$version" "${GITHUB_SHA:-local}" > "$stage/build.json"
chmod 755 "$stage/"*.sh "$stage/rightdata"
bash "$stage/preflight.sh"
python3 test/server/linux-package-smoke.py "$stage"
(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar -czf "test/artifacts/release/RightDataServer-$version-linux-x64.tar.gz" -C "$stage" .
