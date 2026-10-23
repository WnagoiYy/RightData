#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ $(uname -m) == x86_64 ]] || { echo 'Requires Linux x86_64 / Hygon C86.' >&2; exit 1; }
for tool in getconf ldd sort; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
glibc=$(getconf GNU_LIBC_VERSION | awk '{print $2}')
[[ $(printf '%s\n' 2.28 "$glibc" | sort -V | head -n1) == 2.28 ]] || { echo 'Requires glibc >= 2.28.' >&2; exit 1; }
for binary in ./rightdata ./resource/duckdb/v2.0.0/linux_amd64/httpfs.duckdb_extension; do
  report=$(ldd "$binary" 2>&1) || { printf '%s\n' "$report" >&2; exit 1; }
  if [[ $report == *'not found'* ]]; then printf '%s\n' "$report" >&2; exit 1; fi
done
./rightdata --help >/dev/null
echo "Linux x86_64 runtime dependencies passed (glibc $glibc)."
