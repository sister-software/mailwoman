#!/usr/bin/env bash
# Re-fetch the IMLS Public Libraries Survey (PLS) outlet-level data.
# Each US public library branch (outlet) is one row, ~17K rows with
# address fields. Source for the planned `usgov-imls-pls` adapter.
# US Public Domain (federal statistical survey).
#
# The FY 2023 release is the most current as of 2026-05. IMLS ships a
# single ZIP containing CSV, SAS, and SPSS variants. We extract the
# outlet-level CSV (pls_fy*_outlet*.csv or similar) and discard the rest.
# The administrative-entity (system-level) CSV is intentionally skipped —
# it has no per-branch address detail.
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-imls-pls.sh
#
# Defaults to writing under ./data/corpus/sources/ in the repo root.
# Idempotent: if dest CSV exists and sha matches MANIFEST, skips download.

set -euo pipefail

# The PLS FY 2023 bulk CSV ZIP (most recent as of 2026-05).
# If IMLS publishes a newer year, update this URL.
ZIP_URL="https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip"
SLUG="usgov-imls-pls"

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
dest_dir="$OUT_ROOT/$SLUG"
mkdir -p "$dest_dir"

zip_filename=$(basename "$ZIP_URL")
zip_dest="$dest_dir/$zip_filename"
manifest="$dest_dir/MANIFEST.json"

echo "=== $SLUG"

# ------------------------------------------------------------------
# Idempotency check: if outlet CSV already exists and sha matches, skip.
# ------------------------------------------------------------------
if [ -f "$manifest" ]; then
  recorded_sha=$(python3 -c "import json,sys; d=json.load(open('$manifest')); print(d.get('sha256',''))" 2>/dev/null || true)
  recorded_file=$(python3 -c "import json,sys; d=json.load(open('$manifest')); print(d.get('filename',''))" 2>/dev/null || true)
  if [ -n "$recorded_sha" ] && [ -n "$recorded_file" ] && [ -f "$dest_dir/$recorded_file" ]; then
    actual_sha=$(sha256sum "$dest_dir/$recorded_file" | awk '{print $1}')
    if [ "$actual_sha" = "$recorded_sha" ]; then
      echo "  ✓ Already current (sha256 matches MANIFEST) — skipping download."
      exit 0
    fi
  fi
fi

# ------------------------------------------------------------------
# Download ZIP
# ------------------------------------------------------------------
echo "  Downloading $ZIP_URL ..."
curl -fsSL --max-time 600 -o "$zip_dest" "$ZIP_URL" \
  || { echo "  ✗ Download failed" >&2; exit 1; }

zip_size=$(stat -c '%s' "$zip_dest" 2>/dev/null || stat -f '%z' "$zip_dest")
echo "  Downloaded: $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")"

if [ "$zip_size" -lt 1024 ]; then
  echo "  ✗ Response too small ($zip_size bytes) — probable error page" >&2
  exit 1
fi

# ------------------------------------------------------------------
# Discover the outlet-level CSV inside the ZIP.
# Outlet files match: pls_fy*outlet*.csv (case-insensitive)
# Administrative-entity files match: pls_fy*ae*.csv — we skip those.
# ------------------------------------------------------------------
echo "  Inspecting ZIP contents ..."
csv_name=$(
  unzip -l "$zip_dest" \
    | awk '{print $NF}' \
    | grep -iP 'pls_fy.*outlet.*\.csv' \
    | head -1
)

# Fallback: if IMLS renames the file, grab any CSV that is NOT the ae file
if [ -z "$csv_name" ]; then
  csv_name=$(
    unzip -l "$zip_dest" \
      | awk '{print $NF}' \
      | grep -iP '\.csv$' \
      | grep -iv 'system\|state\|_ae\b\|_se\b' \
      | head -1
  )
fi

if [ -z "$csv_name" ]; then
  echo "  Available files in ZIP:"
  unzip -l "$zip_dest" | awk '{print "    " $NF}'
  echo "  ✗ Could not identify outlet CSV — inspect above listing and update script" >&2
  exit 1
fi

echo "  Extracting outlet CSV: $csv_name"
unzip -o -j "$zip_dest" "$csv_name" -d "$dest_dir"

csv_dest="$dest_dir/$(basename "$csv_name")"
csv_size=$(stat -c '%s' "$csv_dest" 2>/dev/null || stat -f '%z' "$csv_dest")
csv_sha=$(sha256sum "$csv_dest" | awk '{print $1}')

# ------------------------------------------------------------------
# Remove ZIP (small, but keep dest_dir clean)
# ------------------------------------------------------------------
rm -f "$zip_dest"
echo "  Removed ZIP (CSV kept)"

# ------------------------------------------------------------------
# Write MANIFEST
# ------------------------------------------------------------------
cat >"$manifest" <<EOF
{
  "source_url": "$ZIP_URL",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "$(basename "$csv_name")",
  "sha256": "$csv_sha",
  "bytes": $csv_size
}
EOF

echo "  ✓ $(numfmt --to=iec "$csv_size" 2>/dev/null || echo "$csv_size bytes")  sha256=$csv_sha"
echo "  MANIFEST written to $manifest"
