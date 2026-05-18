#!/usr/bin/env bash
# Fetch the US DOT National Address Database (NAD) — ~80 million structured
# US address-point records aggregated from state and local authorities.
# Source for the planned `usgov-nad` adapter. US Public Domain (17 U.S.C. § 105).
#
# Distribution shape: NATIONWIDE single ZIP (not per-state).
#   NAD_r17.zip     — file geodatabase (GDB) inside a ZIP, ~7–8 GB on disk
#   NAD_r17_TXT.zip — comma-delimited ASCII equivalent,  ~6 GB on disk
# This script downloads the TXT (CSV) variant by default; set NAD_FORMAT=gdb
# to get the GDB variant instead.
#
# Schema (61 fields, v9 — from FeatureService published by USDOT on ArcGIS):
#   AddNum_Pre, Add_Number, AddNum_Suf, AddNo_Full   — house number parts
#   St_PreMod, St_PreDir, St_PreTyp, St_PreSep       — street pre-components
#   St_Name                                           — street name
#   St_PosTyp, St_PosDir, St_PosMod, StNam_Full      — street post-components
#   Building, Floor, Unit, Room, Seat, Addtl_Loc, SubAddress
#   LandmkName                                        — landmark name
#   County, Inc_Muni, Post_City, Census_Plc, Uninc_Comm, Nbrhd_Comm
#   NatAmArea, NatAmSub, Urbnztn_PR, PlaceOther, PlaceNmTyp
#   State, Zip_Code, Plus_4
#   UUID, AddAuth, AddrRefSys
#   Longitude, Latitude, NatGrid, Elevation
#   Placement, AddrPoint, Related_ID, RelateType
#   ParcelSrc, Parcel_ID, AddrClass, Lifecycle
#   Effective, Expire, DateUpdate
#   AnomStatus, LocatnDesc, Addr_Type, DeliverTyp
#   NAD_Source, DataSet_ID
#
# Access note (as of 2026-05):
#   The S3 bucket (nationaladdressdata.s3.amazonaws.com) is PRIVATE — direct
#   S3 URLs return 403. The canonical download path requires accepting a
#   disclaimer form on www.transportation.gov (Akamai-gated; rejects curl).
#   The Wayback Machine has an archived copy of r17 from 2025-02-05 that IS
#   publicly accessible and is used as the primary fallback here.
#
#   To use an official pre-signed URL (e.g. obtained manually by accepting the
#   disclaimer at https://www.transportation.gov/gis/national-address-database):
#     NAD_URL="<pre-signed-url>" OUT_ROOT=/mnt/... packages/.../fetch-nad.sh
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-nad.sh
#
# Env vars:
#   OUT_ROOT       — destination root (default: ./data/corpus/sources/)
#   NAD_FORMAT     — "txt" (default) or "gdb"
#   NAD_URL        — override primary download URL (e.g. a pre-signed S3 URL)
#   NAD_RELEASE    — override release tag, default "r17"
#
# Idempotent: if dest ZIP already exists and sha256 matches MANIFEST, skip.

set -euo pipefail

NAD_RELEASE="${NAD_RELEASE:-r17}"
NAD_FORMAT="${NAD_FORMAT:-txt}"

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

ZIP_FILENAME="NAD_${NAD_RELEASE}${ZIP_SUFFIX}.zip"
SLUG="usgov-nad"

# Primary canonical URL (S3 — currently private, may be re-opened in future)
S3_URL="https://nationaladdressdata.s3.amazonaws.com/${ZIP_FILENAME}"

# Wayback Machine fallback (archived 2025-02-05 when S3 was still public)
case "$ZIP_FILENAME" in
  NAD_r17_TXT.zip)
    WAYBACK_URL="https://web.archive.org/web/20250205001449/https://nationaladdressdata.s3.amazonaws.com/NAD_r17_TXT.zip"
    ;;
  NAD_r17.zip)
    WAYBACK_URL="https://web.archive.org/web/20250208130702/https://nationaladdressdata.s3.amazonaws.com/NAD_r17.zip"
    ;;
  *)
    WAYBACK_URL=""
    ;;
esac

OUT_ROOT="${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}"
dest_dir="$OUT_ROOT/$SLUG"
mkdir -p "$dest_dir"

dest="$dest_dir/$ZIP_FILENAME"
manifest="$dest_dir/MANIFEST.json"

echo "=== $SLUG / $ZIP_FILENAME  ($FORMAT_LABEL)"

# ------------------------------------------------------------------
# Idempotency: skip if dest ZIP exists and sha256 matches MANIFEST
# ------------------------------------------------------------------
if [ -f "$manifest" ] && [ -f "$dest" ]; then
  recorded_sha=$(python3 -c "import json; d=json.load(open('$manifest')); print(d.get('sha256',''))" 2>/dev/null || true)
  recorded_file=$(python3 -c "import json; d=json.load(open('$manifest')); print(d.get('filename',''))" 2>/dev/null || true)
  if [ "$recorded_file" = "$ZIP_FILENAME" ] && [ -n "$recorded_sha" ]; then
    echo "  Checking sha256 against MANIFEST ..."
    actual_sha=$(sha256sum "$dest" | awk '{print $1}')
    if [ "$actual_sha" = "$recorded_sha" ]; then
      echo "  ✓ Already current (sha256 matches MANIFEST) — skipping download."
      exit 0
    fi
    echo "  sha256 mismatch — will re-download."
  fi
fi

# ------------------------------------------------------------------
# Determine download URL
# ------------------------------------------------------------------
if [ -n "${NAD_URL:-}" ]; then
  download_url="$NAD_URL"
  echo "  Using NAD_URL override: $download_url"
else
  # Try canonical S3 first (fast HEAD check)
  echo "  Checking canonical S3 URL ..."
  s3_status=$(curl -sI --max-time 15 "$S3_URL" 2>/dev/null | grep "^HTTP" | awk '{print $2}' || true)
  if [ "$s3_status" = "200" ]; then
    download_url="$S3_URL"
    echo "  S3 is public — using: $download_url"
  elif [ -n "$WAYBACK_URL" ]; then
    download_url="$WAYBACK_URL"
    echo "  S3 returned HTTP ${s3_status:-???} — falling back to Wayback Machine:"
    echo "    $download_url"
    echo "  NOTE: Wayback may serve more slowly and is not the authoritative source."
    echo "  For the official copy, accept the disclaimer at:"
    echo "    https://www.transportation.gov/gis/national-address-database"
    echo "  then re-run with NAD_URL=<pre-signed-url> ..."
  else
    echo "  ✗ S3 returned HTTP ${s3_status:-???} and no Wayback fallback is configured" >&2
    echo "    for release $NAD_RELEASE. Accept the disclaimer at:" >&2
    echo "    https://www.transportation.gov/gis/national-address-database" >&2
    echo "    then re-run with: NAD_URL=<pre-signed-url> $0" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------
# Download (large file; 2-hour timeout; resume-capable)
# ------------------------------------------------------------------
echo "  Downloading $ZIP_FILENAME ..."
echo "  From: $download_url"
curl -fL \
  --max-time 7200 \
  --continue-at - \
  --progress-bar \
  -o "$dest" \
  "$download_url" \
  || { echo "  ✗ Download failed" >&2; exit 1; }

# ------------------------------------------------------------------
# Verify size (reject obvious error pages < 1 MB)
# ------------------------------------------------------------------
zip_size=$(stat -c '%s' "$dest" 2>/dev/null || stat -f '%z' "$dest")
if [ "$zip_size" -lt 1048576 ]; then
  echo "  ✗ Response too small ($zip_size bytes) — probable error page, not a valid ZIP" >&2
  exit 1
fi
echo "  Downloaded: $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")"

# ------------------------------------------------------------------
# Verify it's actually a ZIP (PK magic bytes)
# ------------------------------------------------------------------
zip_magic=$(xxd -l 4 "$dest" | awk '{print $2$3}' | head -1)
if [[ "$zip_magic" != "504b0304"* && "$zip_magic" != "504b0506"* ]]; then
  echo "  ✗ Downloaded file does not appear to be a valid ZIP (magic: $zip_magic)" >&2
  echo "    This may indicate the Wayback Machine served an error response." >&2
  exit 1
fi

# ------------------------------------------------------------------
# Write MANIFEST
# ------------------------------------------------------------------
sha=$(sha256sum "$dest" | awk '{print $1}')
cat >"$manifest" <<EOF
{
  "source_url": "$S3_URL",
  "download_url_used": "$download_url",
  "nad_release": "$NAD_RELEASE",
  "nad_format": "$NAD_FORMAT",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "$ZIP_FILENAME",
  "sha256": "$sha",
  "bytes": $zip_size,
  "record_count_approx": 80000000,
  "schema_version": "v9",
  "schema_fields": [
    "AddNum_Pre", "Add_Number", "AddNum_Suf", "AddNo_Full",
    "St_PreMod", "St_PreDir", "St_PreTyp", "St_PreSep",
    "St_Name", "St_PosTyp", "St_PosDir", "St_PosMod", "StNam_Full",
    "Building", "Floor", "Unit", "Room", "Seat", "Addtl_Loc", "SubAddress",
    "LandmkName", "County", "Inc_Muni", "Post_City", "Census_Plc",
    "Uninc_Comm", "Nbrhd_Comm", "NatAmArea", "NatAmSub", "Urbnztn_PR",
    "PlaceOther", "PlaceNmTyp", "State", "Zip_Code", "Plus_4",
    "UUID", "AddAuth", "AddrRefSys",
    "Longitude", "Latitude", "NatGrid", "Elevation",
    "Placement", "AddrPoint", "Related_ID", "RelateType",
    "ParcelSrc", "Parcel_ID", "AddrClass", "Lifecycle",
    "Effective", "Expire", "DateUpdate",
    "AnomStatus", "LocatnDesc", "Addr_Type", "DeliverTyp",
    "NAD_Source", "DataSet_ID"
  ]
}
EOF

echo "  ✓ $(numfmt --to=iec "$zip_size" 2>/dev/null || echo "$zip_size bytes")  sha256=$sha"
echo "  MANIFEST written to $manifest"
echo
echo "  Next steps:"
echo "    • Inspect:    unzip -l $dest"
echo "    • Extract CSV: unzip -p $dest '*.csv' | head -3"
echo "    • Re-run with NAD_FORMAT=gdb to also fetch the GDB variant."
