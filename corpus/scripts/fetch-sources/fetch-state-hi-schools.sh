#!/usr/bin/env bash
# Re-fetch the Hawaii State DOE school directory and convert the XLSX workbook
# to a flat CSV the `state-hi-schools` adapter can consume.
#
# Upstream is a single XLSX (~64 KB) with two sheets — `HIDOE` (~258 district
# schools) and `PCS` (~38 public charter schools). Both sheets share the same
# header. This script concatenates them under one shared header so the adapter
# can stream a single CSV.
#
# License: Hawaii state government open data (Tier A — state PD-equivalent).
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-state-hi-schools.sh
#
# Defaults to writing under ./data/corpus/sources/ in the repo root.
# Idempotent: if dest CSV exists and sha matches MANIFEST, skips download.
#
# Dependencies (operator-side):
#   - curl (download)
#   - python3 with `openpyxl` (XLSX → CSV)
#     • Debian/Ubuntu:  sudo apt-get install -y python3-openpyxl
#     • macOS Homebrew: brew install python && pip3 install openpyxl

set -euo pipefail

SOURCE_URL="https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx"
SLUG="state-hi-schools"
CSV_FILENAME="HI_Public_Schools_List.csv"
XLSX_FILENAME="HI_Public_Schools_List.xlsx"

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
dest_dir="$OUT_ROOT/$SLUG"
mkdir -p "$dest_dir"

xlsx_dest="$dest_dir/$XLSX_FILENAME"
csv_dest="$dest_dir/$CSV_FILENAME"
manifest="$dest_dir/MANIFEST.json"

echo "=== $SLUG"

# ------------------------------------------------------------------
# Idempotency: skip if CSV exists and sha matches recorded MANIFEST.
# ------------------------------------------------------------------
if [ -f "$manifest" ] && [ -f "$csv_dest" ]; then
	recorded_sha=$(python3 -c "import json; print(json.load(open('$manifest')).get('sha256',''))" 2>/dev/null || true)
	recorded_file=$(python3 -c "import json; print(json.load(open('$manifest')).get('filename',''))" 2>/dev/null || true)
	if [ -n "$recorded_sha" ] && [ "$recorded_file" = "$CSV_FILENAME" ]; then
		actual_sha=$(sha256sum "$csv_dest" | awk '{print $1}')
		if [ "$actual_sha" = "$recorded_sha" ]; then
			echo "  ✓ Already current (sha256 matches MANIFEST) — skipping download."
			exit 0
		fi
	fi
fi

# ------------------------------------------------------------------
# Preflight: openpyxl must be importable.
# ------------------------------------------------------------------
if ! python3 -c "import openpyxl" >/dev/null 2>&1; then
	cat >&2 <<'MSG'
  ✗ python3 with the `openpyxl` package is required to convert the HIDOE XLSX.
    Debian/Ubuntu:  sudo apt-get install -y python3-openpyxl
    macOS Homebrew: brew install python && pip3 install openpyxl
MSG
	exit 1
fi

# ------------------------------------------------------------------
# Download XLSX
# ------------------------------------------------------------------
echo "  Downloading $SOURCE_URL ..."
curl -fsSL --max-time 600 -o "$xlsx_dest" "$SOURCE_URL" \
	|| { echo "  ✗ Download failed" >&2; exit 1; }

xlsx_size=$(stat -c '%s' "$xlsx_dest" 2>/dev/null || stat -f '%z' "$xlsx_dest")
echo "  Downloaded XLSX: $(numfmt --to=iec "$xlsx_size" 2>/dev/null || echo "$xlsx_size bytes")"

if [ "$xlsx_size" -lt 1024 ]; then
	echo "  ✗ Response too small ($xlsx_size bytes) — probable error page" >&2
	exit 1
fi

# ------------------------------------------------------------------
# Convert XLSX → CSV (concatenate both sheets under one shared header).
# ------------------------------------------------------------------
echo "  Converting XLSX → CSV (concatenating sheets) ..."
python3 - "$xlsx_dest" "$csv_dest" <<'PY'
import csv
import sys
from openpyxl import load_workbook

xlsx_path, csv_path = sys.argv[1], sys.argv[2]
wb = load_workbook(xlsx_path, data_only=True, read_only=True)

with open(csv_path, "w", newline="", encoding="utf-8") as out:
    writer = csv.writer(out)
    shared_header = None
    total_data_rows = 0
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = ws.iter_rows(values_only=True)
        try:
            header = next(rows)
        except StopIteration:
            continue
        norm_header = ["" if v is None else str(v).strip() for v in header]
        if shared_header is None:
            shared_header = norm_header
            writer.writerow(shared_header)
        elif norm_header != shared_header:
            print(
                f"  ! sheet '{sheet_name}' header diverges from shared header; concatenating anyway",
                file=sys.stderr,
            )
        for row in rows:
            if row is None:
                continue
            # Skip fully-empty rows (XLSX iter_rows can yield phantom trailing rows).
            if all(v is None or (isinstance(v, str) and not v.strip()) for v in row):
                continue
            writer.writerow(["" if v is None else str(v).strip() for v in row])
            total_data_rows += 1

print(f"  converted {total_data_rows} data rows from {len(wb.sheetnames)} sheets", file=sys.stderr)
PY

csv_size=$(stat -c '%s' "$csv_dest" 2>/dev/null || stat -f '%z' "$csv_dest")
csv_sha=$(sha256sum "$csv_dest" | awk '{print $1}')

# ------------------------------------------------------------------
# Remove XLSX (CSV is the canonical artifact the adapter consumes).
# ------------------------------------------------------------------
rm -f "$xlsx_dest"
echo "  Removed XLSX (CSV kept)"

# ------------------------------------------------------------------
# Write MANIFEST
# ------------------------------------------------------------------
cat >"$manifest" <<EOF
{
  "source_url": "$SOURCE_URL",
  "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "filename": "$CSV_FILENAME",
  "sha256": "$csv_sha",
  "bytes": $csv_size,
  "notes": "Converted from XLSX (sheets HIDOE + PCS concatenated under shared header)."
}
EOF

echo "  ✓ $(numfmt --to=iec "$csv_size" 2>/dev/null || echo "$csv_size bytes")  sha256=$csv_sha"
echo "  MANIFEST written to $manifest"
