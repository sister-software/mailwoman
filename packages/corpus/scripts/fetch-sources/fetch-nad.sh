#!/usr/bin/env bash
# Fetch the US DOT National Address Database (NAD) — ~97 million structured
# US address-point records aggregated from state and local authorities.
# Source for the planned `usgov-nad` adapter. US Public Domain (17 U.S.C. § 105).
#
# NAD r17 (Aug 2024 release, ~80M records in the bulk ZIP):
#   NAD_r17.zip     — file geodatabase (GDB) inside a ZIP, ~7–8 GB
#   NAD_r17_TXT.zip — comma-delimited ASCII, ~6 GB
# The live ArcGIS FeatureService currently reports 97M records (as of 2026-05),
# updated more frequently than the bulk ZIP releases.
#
# Schema (61 fields, v9 — confirmed against ArcGIS FeatureServer published by USDOT):
#   House number:  AddNum_Pre, Add_Number, AddNum_Suf, AddNo_Full
#   Street pre:    St_PreMod, St_PreDir, St_PreTyp, St_PreSep
#   Street name:   St_Name
#   Street post:   St_PosTyp, St_PosDir, St_PosMod, StNam_Full
#   Sub-address:   Building, Floor, Unit, Room, Seat, Addtl_Loc, SubAddress
#   Landmark:      LandmkName
#   Place names:   County, Inc_Muni, Post_City, Census_Plc, Uninc_Comm, Nbrhd_Comm,
#                  NatAmArea, NatAmSub, Urbnztn_PR, PlaceOther, PlaceNmTyp
#   State/ZIP:     State, Zip_Code, Plus_4
#   Geospatial:    Longitude, Latitude, NatGrid, Elevation, Placement, AddrPoint
#   Identity:      UUID, AddAuth, AddrRefSys, Related_ID, RelateType
#   Parcel:        ParcelSrc, Parcel_ID
#   Classification: AddrClass, Lifecycle, Effective, Expire, DateUpdate
#   Status:        AnomStatus, LocatnDesc, Addr_Type, DeliverTyp
#   Provenance:    NAD_Source, DataSet_ID
#
# ── Access options (as of 2026-05) ─────────────────────────────────────────
#
# OPTION A — Official DOT download (recommended, browser-only):
#   1. Visit: https://www.transportation.gov/gis/national-address-database
#   2. Click "Download the NAD" in the left menu
#   3. Accept the disclaimer — DOT generates a pre-signed S3 URL
#   4. Copy the URL and re-run: NAD_URL="<pre-signed-url>" ./fetch-nad.sh
#   Note: The DOT site uses Akamai Bot Manager; unattended curl returns 403.
#
# OPTION B — ArcGIS paged export (automated; slow for full dataset):
#   Set NAD_MODE=featureserver to page through the live FeatureService.
#   Saves per-state NDJSON chunks under $OUT_ROOT/usgov-nad/featureserver/.
#   Use STATES= to subset: STATES="HI AK PR" ./fetch-nad.sh --mode featureserver
#
# OPTION C — Environment override for any accessible URL:
#   NAD_URL="https://..." ./fetch-nad.sh
#   Useful for: pre-signed DOT URLs, institutional mirrors, or if S3 re-opens.
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-nad.sh
#
# Env vars:
#   OUT_ROOT     — destination root (default: ./data/corpus/sources/)
#   NAD_FORMAT   — "txt" (default) or "gdb"  [only used in bulk-download mode]
#   NAD_URL      — override primary download URL
#   NAD_RELEASE  — override release tag, default "r17"
#   NAD_MODE     — "bulk" (default) or "featureserver"
#   STATES       — space-separated state codes for featureserver mode
#                  (default: all 50 states + DC + AS + GU + PR + VI + MP)
#
# Idempotent: in bulk mode, skips if dest ZIP exists and sha256 matches MANIFEST.
# In featureserver mode, skips per-state files already written.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────

NAD_RELEASE="${NAD_RELEASE:-r17}"
NAD_FORMAT="${NAD_FORMAT:-txt}"
NAD_MODE="${NAD_MODE:-bulk}"

SLUG="usgov-nad"
OUT_ROOT="${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}"
dest_dir="$OUT_ROOT/$SLUG"
mkdir -p "$dest_dir"

FEATURE_SERVICE_URL="https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/Address_Points_from_National_Address_Database_view/FeatureServer/0"

# All US states + DC + territories
ALL_STATES=(
  AL AK AZ AR CA CO CT DE FL GA
  HI ID IL IN IA KS KY LA ME MD
  MA MI MN MS MO MT NE NV NH NJ
  NM NY NC ND OH OK OR PA RI SC
  SD TN TX UT VT VA WA WV WI WY
  DC
  AS GU MP PR VI
)

# ── Mode: featureserver ───────────────────────────────────────────────────────

featureserver_mode() {
  local chunk_dir="$dest_dir/featureserver"
  mkdir -p "$chunk_dir"

  # Determine state list
  if [ -n "${STATES:-}" ]; then
    read -r -a state_list <<< "$STATES"
  else
    state_list=("${ALL_STATES[@]}")
  fi

  local fetched=0
  local skipped=0
  local failed=0

  for state in "${state_list[@]}"; do
    local state_file="$chunk_dir/${state}.ndjson"
    local state_manifest="$chunk_dir/${state}.manifest.json"

    echo "=== $SLUG / featureserver / $state"

    # Idempotency: skip if manifest shows complete
    if [ -f "$state_manifest" ]; then
      is_complete=$(python3 -c "import json; d=json.load(open('$state_manifest')); print(d.get('complete', False))" 2>/dev/null || echo "False")
      if [ "$is_complete" = "True" ]; then
        echo "  ✓ Already complete (MANIFEST) — skipping."
        skipped=$((skipped + 1))
        continue
      fi
    fi

    # Count records for this state
    count_resp=$(curl -sS --max-time 30 \
      "${FEATURE_SERVICE_URL}/query?where=State+%3D+%27${state}%27&returnCountOnly=true&f=json" 2>/dev/null || echo '{"count":0}')
    total=$(python3 -c "import json; print(json.loads('${count_resp}').get('count', 0))" 2>/dev/null || echo "0")
    echo "  Records: $total"

    if [ "$total" -eq 0 ]; then
      echo "  ✗ Zero records for state $state — skipping (state may not be in NAD yet)."
      failed=$((failed + 1))
      continue
    fi

    # Page through and write NDJSON
    local offset=0
    local page_size=2000
    local written=0
    : > "$state_file"  # truncate

    while [ "$offset" -lt "$total" ]; do
      resp=$(curl -sS --max-time 60 \
        "${FEATURE_SERVICE_URL}/query?where=State+%3D+%27${state}%27&outFields=*&f=json&resultOffset=${offset}&resultRecordCount=${page_size}" 2>/dev/null) || {
        echo "  ✗ Page fetch failed at offset $offset" >&2
        failed=$((failed + 1))
        break
      }

      page_count=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
features = d.get('features', [])
for f in features:
    print(json.dumps(f['attributes']))
print(len(features), file=sys.stderr)
" "$resp" >> "$state_file" 2>&1) || true

      page_n=$(python3 -c "import json; d=json.loads('${resp}'); print(len(d.get('features', [])))" 2>/dev/null || echo "0")
      written=$((written + page_n))
      offset=$((offset + page_size))

      if [ "$page_n" -lt "$page_size" ]; then
        break
      fi
    done

    local file_size
    file_size=$(stat -c '%s' "$state_file" 2>/dev/null || stat -f '%z' "$state_file")
    local sha
    sha=$(sha256sum "$state_file" | awk '{print $1}')

    cat > "$state_manifest" <<MANIFEST_EOF
{
  "source_url": "${FEATURE_SERVICE_URL}",
  "state": "${state}",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "${state}.ndjson",
  "sha256": "${sha}",
  "bytes": ${file_size},
  "record_count": ${written},
  "complete": true
}
MANIFEST_EOF

    echo "  ✓ $written records  $(numfmt --to=iec "$file_size" 2>/dev/null || echo "$file_size bytes")  sha256=$sha"
    fetched=$((fetched + 1))
  done

  echo
  echo "=== featureserver summary ==="
  echo "fetched: $fetched  |  skipped (already done): $skipped  |  failed: $failed"
  [ "$failed" -eq 0 ]
}

# ── Mode: bulk (ZIP from DOT S3) ─────────────────────────────────────────────

bulk_mode() {
  case "$NAD_FORMAT" in
    txt|TXT)
      ZIP_SUFFIX="_TXT"
      FORMAT_LABEL="CSV/ASCII"
      ;;
    gdb|GDB)
      ZIP_SUFFIX=""
      FORMAT_LABEL="file geodatabase"
      ;;
    *)
      echo "NAD_FORMAT must be 'txt' or 'gdb', got: $NAD_FORMAT" >&2
      exit 1
      ;;
  esac

  local zip_filename="NAD_${NAD_RELEASE}${ZIP_SUFFIX}.zip"
  local s3_url="https://nationaladdressdata.s3.amazonaws.com/${zip_filename}"
  local dest="$dest_dir/$zip_filename"
  local manifest="$dest_dir/MANIFEST.json"

  echo "=== $SLUG / $zip_filename  ($FORMAT_LABEL)"

  # Idempotency: skip if dest ZIP exists and sha256 matches MANIFEST
  if [ -f "$manifest" ] && [ -f "$dest" ]; then
    local recorded_sha recorded_file
    recorded_sha=$(python3 -c "import json; d=json.load(open('$manifest')); print(d.get('sha256',''))" 2>/dev/null || true)
    recorded_file=$(python3 -c "import json; d=json.load(open('$manifest')); print(d.get('filename',''))" 2>/dev/null || true)
    if [ "$recorded_file" = "$zip_filename" ] && [ -n "$recorded_sha" ]; then
      echo "  Checking sha256 against MANIFEST ..."
      local actual_sha
      actual_sha=$(sha256sum "$dest" | awk '{print $1}')
      if [ "$actual_sha" = "$recorded_sha" ]; then
        echo "  ✓ Already current (sha256 matches MANIFEST) — skipping download."
        return 0
      fi
      echo "  sha256 mismatch — will re-download."
    fi
  fi

  # Determine download URL
  local download_url
  if [ -n "${NAD_URL:-}" ]; then
    download_url="$NAD_URL"
    echo "  Using NAD_URL override: $download_url"
  else
    # Try canonical S3 first (fast HEAD check)
    echo "  Checking canonical S3 URL ..."
    local s3_status
    s3_status=$(curl -sI --max-time 15 "$s3_url" 2>/dev/null | grep "^HTTP" | awk '{print $2}' || true)
    if [ "$s3_status" = "200" ]; then
      download_url="$s3_url"
      echo "  S3 is public — using: $download_url"
    else
      echo "  ✗ S3 returned HTTP ${s3_status:-???}"
      echo
      echo "  The NAD S3 bucket is currently private. To download the bulk ZIP:"
      echo
      echo "  1. Visit: https://www.transportation.gov/gis/national-address-database"
      echo "  2. Click \"Download the NAD\" in the left-side menu"
      echo "  3. Accept the disclaimer (browser only; Akamai blocks automated curl)"
      echo "  4. Copy the resulting S3 pre-signed URL"
      echo "  5. Re-run: NAD_URL=\"<url>\" $0"
      echo
      echo "  Alternatively, use featureserver mode for automated per-state paged download:"
      echo "    NAD_MODE=featureserver $0"
      echo "    NAD_MODE=featureserver STATES=\"HI AK PR\" $0  # subset"
      exit 1
    fi
  fi

  # Download (large file; 2-hour timeout; resume-capable)
  echo "  Downloading $zip_filename ..."
  echo "  From: $download_url"
  curl -fL \
    --max-time 7200 \
    --continue-at - \
    --progress-bar \
    -o "$dest" \
    "$download_url" \
    || { echo "  ✗ Download failed" >&2; exit 1; }

  # Verify size (reject obvious error pages < 1 MB)
  local zip_size
  zip_size=$(stat -c '%s' "$dest" 2>/dev/null || stat -f '%z' "$dest")
  if [ "$zip_size" -lt 1048576 ]; then
    echo "  ✗ Response too small ($zip_size bytes) — probable error page, not a valid ZIP" >&2
    exit 1
  fi
  echo "  Downloaded: $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")"

  # Verify it's actually a ZIP (PK magic bytes)
  local zip_magic
  zip_magic=$(xxd -l 4 "$dest" | awk '{print $2$3}' | head -1)
  if [[ "$zip_magic" != "504b0304"* && "$zip_magic" != "504b0506"* ]]; then
    echo "  ✗ Downloaded file does not appear to be a valid ZIP (magic: $zip_magic)" >&2
    exit 1
  fi

  # Write MANIFEST
  local sha
  sha=$(sha256sum "$dest" | awk '{print $1}')
  cat >"$manifest" <<MANIFEST_EOF
{
  "source_url": "${s3_url}",
  "download_url_used": "${download_url}",
  "nad_release": "${NAD_RELEASE}",
  "nad_format": "${NAD_FORMAT}",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "${zip_filename}",
  "sha256": "${sha}",
  "bytes": ${zip_size},
  "record_count_approx": 80000000,
  "schema_version": "v9"
}
MANIFEST_EOF

  echo "  ✓ $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")  sha256=$sha"
  echo "  MANIFEST written to $manifest"
  echo
  echo "  Next steps:"
  echo "    • Inspect:     unzip -l $dest"
  echo "    • Sample CSV:  unzip -p $dest '*.txt' | head -3"
  echo "    • Re-run:      NAD_FORMAT=gdb $0  (to also fetch the GDB variant)"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

case "$NAD_MODE" in
  bulk)
    bulk_mode
    ;;
  featureserver|fs)
    featureserver_mode
    ;;
  *)
    echo "NAD_MODE must be 'bulk' or 'featureserver', got: $NAD_MODE" >&2
    exit 1
    ;;
esac
