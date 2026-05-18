#!/usr/bin/env bash
# Re-fetch the NPPES (National Plan and Provider Enumeration System) full
# monthly data dissemination file. ~7M provider rows with venue+address data.
# Source for the planned `usgov-nppes` adapter. US Public Domain.
#
# The file is published monthly by CMS. This script discovers the current
# filename by scraping the NPI_Files.html index, then downloads the ZIP and
# extracts only the main registry CSV (npidata_pfile_*.csv). The smaller
# endpoint/othername/pl files stay zipped — we don't need them.
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-nppes.sh
#
# Defaults to writing under ./data/corpus/sources/ in the repo root.
# Idempotent: if dest CSV exists and sha256 matches MANIFEST, skips download.

set -euo pipefail

INDEX_URL="https://download.cms.gov/nppes/NPI_Files.html"
BASE_URL="https://download.cms.gov/nppes"
SLUG="usgov-nppes"

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
dest_dir="$OUT_ROOT/$SLUG"
mkdir -p "$dest_dir"

echo "=== $SLUG"
echo "  Discovering latest full-replacement ZIP from $INDEX_URL ..."

# Parse the HTML index for the latest full monthly ZIP.
# Full replacement files match NPPES_Data_Dissemination_<Month>_<Year>*.zip
# (weekly files contain a date range like 050426_051026; we exclude those).
zip_filename=$(
  curl -fsSL --max-time 60 "$INDEX_URL" \
    | grep -oP 'NPPES_Data_Dissemination_[A-Za-z]+_\d{4}[^"]*\.zip' \
    | grep -v '[0-9]\{6\}_[0-9]\{6\}' \
    | head -1
)

if [ -z "$zip_filename" ]; then
  echo "  ✗ Could not discover ZIP filename from $INDEX_URL" >&2
  exit 1
fi

zip_url="$BASE_URL/$zip_filename"
zip_dest="$dest_dir/$zip_filename"
echo "  Latest full file: $zip_filename"

# ------------------------------------------------------------------
# Idempotency check: if the main CSV already exists and sha matches,
# skip re-download.
# ------------------------------------------------------------------
manifest="$dest_dir/MANIFEST.json"
if [ -f "$manifest" ] && [ -f "$dest_dir/MANIFEST.json" ]; then
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
# Download ZIP (large; 60-minute timeout; resume if partial)
# ------------------------------------------------------------------
echo "  Downloading $zip_url ..."
curl -fL --max-time 3600 --continue-at - -o "$zip_dest" "$zip_url" \
  || { echo "  ✗ Download failed" >&2; exit 1; }

zip_size=$(stat -c '%s' "$zip_dest" 2>/dev/null || stat -f '%z' "$zip_dest")
echo "  Downloaded: $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")"

# ------------------------------------------------------------------
# Extract only the main registry CSV (npidata_pfile_*.csv)
# ------------------------------------------------------------------
echo "  Extracting npidata_pfile CSV from ZIP ..."
csv_name=$(unzip -l "$zip_dest" | grep -oP 'npidata_pfile[^\s]+\.csv' | head -1)

if [ -z "$csv_name" ]; then
  echo "  ✗ Could not find npidata_pfile CSV inside ZIP" >&2
  exit 1
fi

echo "  Extracting: $csv_name"
unzip -o -j "$zip_dest" "$csv_name" -d "$dest_dir"

csv_dest="$dest_dir/$csv_name"
csv_size=$(stat -c '%s' "$csv_dest" 2>/dev/null || stat -f '%z' "$csv_dest")
csv_sha=$(sha256sum "$csv_dest" | awk '{print $1}')

echo "  CSV size: $(numfmt --to=iec "$csv_size" 2>/dev/null || echo "$csv_size bytes")"

# ------------------------------------------------------------------
# Remove the ZIP to reclaim ~1 GB (the CSV is what adapters consume)
# ------------------------------------------------------------------
rm -f "$zip_dest"
echo "  Removed ZIP (CSV kept)"

# ------------------------------------------------------------------
# Write MANIFEST (records the extracted CSV, not the ZIP)
# ------------------------------------------------------------------
cat >"$manifest" <<EOF
{
  "source_url": "$zip_url",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "$csv_name",
  "sha256": "$csv_sha",
  "bytes": $csv_size
}
EOF

echo "  ✓ $(numfmt --to=iec "$csv_size" 2>/dev/null || echo "$csv_size bytes")  sha256=$csv_sha"
echo "  MANIFEST written to $manifest"
