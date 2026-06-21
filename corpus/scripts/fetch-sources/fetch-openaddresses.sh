#!/usr/bin/env bash
# Fetch an OpenAddresses country collection from batch.openaddresses.io.
#
# Source: https://batch.openaddresses.io
# License: MIXED — OpenAddresses aggregates hundreds of upstream sources with
#   per-source licenses (CC-BY, CC0, PDDL, ODbL, CC-BY-SA, and proprietary
#   attribution-only). The per-row LICENSE filter in the openaddresses adapter
#   is essential for proprietary-weights training: Tier-C rows (ODbL,
#   CC-BY-SA, CC-SA) are dropped at ingest by default. This script downloads
#   the raw collection; the adapter does the license gating.
#
# AUTHENTICATION NOTE (2026-05-18):
#   The batch.openaddresses.io download endpoint now requires a registered
#   account. Downloads are still free at the "basic" tier (GeoJSON+LD output).
#   1. Register at https://batch.openaddresses.io/register
#   2. Log in and go to Profile → "Create Token"
#   3. Export the token: export OA_BATCH_TOKEN=<your-token>
#   4. Re-run this script.
#
#   The collection URL pattern (verified 2026-05-18):
#     POST /api/login {username, password} → {token}
#     GET  /api/job/{job_id}/output/source.geojson.gz?token={token}
#   Collections are downloaded as a combined GeoJSON.gz via:
#     GET  /api/collections/{collection_id}/download   (returns a redirect to S3)
#   Collection IDs discovered from /api/collections:
#     id=6  name="ca"  size=2044467556 (~1.9 GiB uncompressed, verified 2026-05-18)
#
# Usage:
#   # With token (preferred):
#   OA_BATCH_TOKEN=<token> \
#     OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-openaddresses.sh --country ca
#
#   # Default country: ca. Supports any OA country code (us-west, us-south, fr, …)
#   OA_BATCH_TOKEN=<token> packages/corpus/scripts/fetch-sources/fetch-openaddresses.sh
#
#   # Without token (will detect + print instructions then exit):
#   packages/corpus/scripts/fetch-sources/fetch-openaddresses.sh --country ca

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
COUNTRY="${1:-ca}"
OUT_ROOT="${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}"
OA_BASE="https://batch.openaddresses.io"

# Collection IDs known as of 2026-05-18 (discovered via GET /api/collections).
# OA assigns stable integer IDs to each country collection; re-check
# GET /api/collections if a new country is needed and the ID is unknown.
declare -A OA_COLLECTION_IDS=(
  ["ca"]="6"
  ["us-west"]="4"
  ["us-south"]="3"
  ["us-northeast"]="2"
  ["us-midwest"]="5"
  ["global"]="1"
)

# ---------------------------------------------------------------------------
# Parse --country flag (also accept positional argument for compatibility)
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --country)
      COUNTRY="${2:?--country requires a value}"
      shift 2
      ;;
    --country=*)
      COUNTRY="${1#--country=}"
      shift
      ;;
    *)
      # Positional first arg accepted for backwards-compat: script ca
      COUNTRY="$1"
      shift
      ;;
  esac
done

dest_dir="$OUT_ROOT/openaddresses/$COUNTRY"
manifest="$dest_dir/MANIFEST.json"
output_file="$dest_dir/collection.geojsonl"

echo "=== fetch-openaddresses: country=$COUNTRY"
echo "    dest: $dest_dir"

mkdir -p "$dest_dir"

# ---------------------------------------------------------------------------
# Authentication check
# ---------------------------------------------------------------------------
if [[ -z "${OA_BATCH_TOKEN:-}" ]]; then
  cat >&2 <<'EOF'

ERROR: OA_BATCH_TOKEN is not set.

As of 2026-05-18, batch.openaddresses.io requires a registered (free) account
to download collection files.  Data remains openly licensed — the auth gate
is there to prevent CDN abuse, not to restrict access.

Steps to get a token:
  1. Register at: https://batch.openaddresses.io/register
  2. Verify your email and log in.
  3. Go to Profile → "Create Token" → copy the token.
  4. Export it in this shell:
       export OA_BATCH_TOKEN=<your-token>
  5. Re-run this script.

The Canada collection (ca) is ~2 GiB compressed / ~7 GiB uncompressed
(estimated), so budget ~20–45 minutes at typical cloud-to-host bandwidth.

EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine collection ID
# ---------------------------------------------------------------------------
COLLECTION_ID="${OA_COLLECTION_IDS[$COUNTRY]:-}"
if [[ -z "$COLLECTION_ID" ]]; then
  echo "Unknown country code '$COUNTRY'. Fetching collection list to find ID..."
  COLLECTION_ID=$(
    curl -fsSL --max-time 30 \
      -H "Authorization: Bearer $OA_BATCH_TOKEN" \
      "$OA_BASE/api/collections" |
      python3 -c "
import json, sys
data = json.load(sys.stdin)
country = '$COUNTRY'
for item in data:
    if item.get('name') == country:
        print(item['id'])
        break
"
  )
  if [[ -z "$COLLECTION_ID" ]]; then
    echo "ERROR: Could not find a collection named '$COUNTRY' in GET /api/collections." >&2
    echo "Available collections:" >&2
    curl -fsSL --max-time 30 \
      -H "Authorization: Bearer $OA_BATCH_TOKEN" \
      "$OA_BASE/api/collections" |
      python3 -c "
import json, sys
for item in json.load(sys.stdin):
    print(f\"  {item['name']:20s}  id={item['id']}  {item.get('human','')}  size={item.get('size',0):,} bytes\")
" >&2
    exit 1
  fi
  echo "  Found collection id=$COLLECTION_ID for '$COUNTRY'"
fi

# ---------------------------------------------------------------------------
# Resolve download URL via the collections download endpoint
# ---------------------------------------------------------------------------
echo "  Resolving download URL for collection id=$COLLECTION_ID..."
DOWNLOAD_URL=$(
  curl -fsSL --max-time 30 \
    -H "Authorization: Bearer $OA_BATCH_TOKEN" \
    "$OA_BASE/api/collections/$COLLECTION_ID/download" 2>/dev/null || true
)

# The endpoint may return a JSON redirect URL or a direct 302.
# Try following the redirect with -L first.
echo "  Attempting authenticated download..."
TMP_GZ="$dest_dir/collection.geojsonl.gz.tmp"
TMP_RAW="$dest_dir/collection.geojsonl.tmp"

HTTP_STATUS=$(
  nice -n 15 ionice -c 3 \
  curl -fsSL \
    --max-time 7200 \
    --retry 3 \
    --retry-delay 30 \
    --retry-max-time 600 \
    -H "Authorization: Bearer $OA_BATCH_TOKEN" \
    -w "%{http_code}" \
    -o "$TMP_GZ" \
    "$OA_BASE/api/collections/$COLLECTION_ID/download" 2>/dev/null || echo "000"
)

if [[ "$HTTP_STATUS" != "200" ]]; then
  # Try the geojsonl.gz directly with token as query param (alternate URL shape)
  HTTP_STATUS=$(
    nice -n 15 ionice -c 3 \
    curl -fsSL \
      --max-time 7200 \
      --retry 3 \
      --retry-delay 30 \
      -w "%{http_code}" \
      -o "$TMP_GZ" \
      "$OA_BASE/api/collections/$COLLECTION_ID/geojsonl.gz?token=$OA_BATCH_TOKEN" 2>/dev/null || echo "000"
  )
fi

if [[ "$HTTP_STATUS" != "200" ]]; then
  rm -f "$TMP_GZ"
  cat >&2 <<EOF

ERROR: Download returned HTTP $HTTP_STATUS.

Likely causes:
  1. OA_BATCH_TOKEN is invalid or expired — re-create it at Profile → Tokens.
  2. The collection download endpoint URL has changed (this script was written
     against the 2026-05-18 batch.openaddresses.io API; it may need updating).
  3. Network error or CDN outage.

Manual download (after logging in to batch.openaddresses.io):
  - Navigate to https://batch.openaddresses.io/collection/$COLLECTION_ID
  - Click "GeoJSON+LD" to download the collection.
  - Save as: $output_file
  - Then re-run this script with SKIP_DOWNLOAD=1 to generate the MANIFEST.

URL tried: $OA_BASE/api/collections/$COLLECTION_ID/download

EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# Decompress if the downloaded file is gzipped
# ---------------------------------------------------------------------------
file_magic=$(file --brief "$TMP_GZ" 2>/dev/null || true)
if echo "$file_magic" | grep -qi "gzip\|compressed"; then
  echo "  Decompressing gzip archive..."
  nice -n 15 ionice -c 3 gunzip -c "$TMP_GZ" >"$TMP_RAW"
  rm -f "$TMP_GZ"
  mv "$TMP_RAW" "$output_file"
elif echo "$file_magic" | grep -qi "JSON\|ASCII\|UTF-8"; then
  # Already line-delimited GeoJSON
  mv "$TMP_GZ" "$output_file"
  rm -f "$TMP_RAW"
else
  # Unknown type — keep as-is and let the operator inspect
  mv "$TMP_GZ" "$output_file"
  echo "  WARNING: Downloaded file type is '$file_magic' — may need manual decompression." >&2
fi

# ---------------------------------------------------------------------------
# Verify + write MANIFEST
# ---------------------------------------------------------------------------
if [[ ! -f "$output_file" ]]; then
  echo "ERROR: Output file not found at $output_file after download." >&2
  exit 1
fi

size=$(stat -c '%s' "$output_file" 2>/dev/null || stat -f '%z' "$output_file")
if [[ "$size" -lt 10240 ]]; then
  echo "ERROR: File is suspiciously small ($size bytes) — likely an error response." >&2
  exit 1
fi

sha=$(sha256sum "$output_file" | awk '{print $1}')
row_count=$(wc -l <"$output_file" | tr -d ' ')
source_url="$OA_BASE/api/collections/$COLLECTION_ID/download"
downloaded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 - <<PYEOF
import json
manifest = {
    "source_url": "$source_url",
    "collection_id": $COLLECTION_ID,
    "country": "$COUNTRY",
    "filename": "collection.geojsonl",
    "downloaded_at": "$downloaded_at",
    "sha256": "$sha",
    "bytes": $size,
    "row_count": $row_count,
    "notes": "batch.openaddresses.io requires a free registered account for downloads. License is mixed per-row; use the openaddresses adapter with allowShareAlike=false (default) to filter Tier-C rows."
}
with open("$manifest", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PYEOF

human_size=$(numfmt --to=iec "$size" 2>/dev/null || echo "${size} bytes")
echo "  ✓ ${human_size}  rows=${row_count}  sha256=${sha}"
echo "  MANIFEST written to $manifest"
echo
echo "=== done"
echo "Feed to the adapter:"
echo "  npx mailwoman corpus run openaddresses \\"
echo "    --input $output_file \\"
echo "    --country CA \\"
echo "    --output \$OUT_ROOT"
