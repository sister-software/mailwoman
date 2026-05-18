#!/usr/bin/env bash
# Re-fetch the HRSA Health Center Service Delivery Sites CSV.
# Source for the `usgov-hrsa-fqhc` adapter. US Public Domain.
#
# Usage:
#   OUT_ROOT=/data/corpus/sources packages/corpus/scripts/fetch-sources/fetch-hrsa.sh
#
# Defaults to writing under ./data/corpus/sources/ in the repo root.

set -euo pipefail

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
dest_dir="$OUT_ROOT/usgov-hrsa-fqhc"
filename="Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
url="https://data.hrsa.gov/DataDownload/DD_Files/$filename"

mkdir -p "$dest_dir"
dest="$dest_dir/$filename"

echo "=== usgov-hrsa-fqhc / $filename"
curl -fsSL --max-time 600 -o "$dest" "$url"

size=$(stat -c '%s' "$dest" 2>/dev/null || stat -f '%z' "$dest")
sha=$(sha256sum "$dest" | awk '{print $1}')

cat >"$dest_dir/MANIFEST.json" <<EOF
{
  "source_url": "$url",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "$filename",
  "sha256": "$sha",
  "bytes": $size
}
EOF

echo "  ✓ $(numfmt --to=iec "$size" 2>/dev/null || echo "$size bytes")  sha256=$sha"
