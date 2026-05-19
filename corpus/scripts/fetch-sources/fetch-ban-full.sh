#!/usr/bin/env bash
# Fetch the full French BAN (Base Adresse Nationale) — all metropolitan
# départements (01-95, 2A, 2B) plus 5 overseas DOM/TOM (971-976 excl. 975).
#
# Source: https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/
# Licence: Licence Ouverte 2.0 (attribution required — Tier B)
#
# Files already present with matching sha256 are skipped (re-runnable).
# Downloads .csv.gz, decompresses to .csv, deletes the .gz artifact.
# One shared MANIFEST.json at $OUT_ROOT/ban/MANIFEST.json covers all codes.
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-ban-full.sh

set -euo pipefail

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
BAN_DIR="$OUT_ROOT/ban"
MANIFEST="$BAN_DIR/MANIFEST.json"
BASE_URL="https://adresse.data.gouv.fr/data/ban/adresses/latest/csv"

mkdir -p "$BAN_DIR"

# All département codes — metropolitan 01-95 (with 2A/2B for Corsica instead
# of 20) plus overseas DOM/TOM.  Codes do not change.
DEPT_CODES=(
  "01" "02" "03" "04" "05" "06" "07" "08" "09"
  "10" "11" "12" "13" "14" "15" "16" "17" "18" "19"
  "21" "22" "23" "24" "25" "26" "27" "28" "29"
  "2A" "2B"
  "30" "31" "32" "33" "34" "35" "36" "37" "38" "39"
  "40" "41" "42" "43" "44" "45" "46" "47" "48" "49"
  "50" "51" "52" "53" "54" "55" "56" "57" "58" "59"
  "60" "61" "62" "63" "64" "65" "66" "67" "68" "69"
  "70" "71" "72" "73" "74" "75" "76" "77" "78" "79"
  "80" "81" "82" "83" "84" "85" "86" "87" "88" "89"
  "90" "91" "92" "93" "94" "95"
  "971" "972" "973" "974" "976"
)

# Load existing MANIFEST entries (code -> sha256) so we can skip unchanged files.
declare -A MANIFEST_SHA
if [[ -f "$MANIFEST" ]]; then
  # Each entry is an object in a top-level array; extract code+sha256 pairs.
  while IFS='=' read -r code sha; do
    MANIFEST_SHA["$code"]="$sha"
  done < <(python3 - "$MANIFEST" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
for entry in data:
    print(f"{entry['dept_code']}={entry['sha256']}")
PYEOF
)
fi

fetched=0
skipped=0
failed=0
failed_codes=()
# We'll accumulate MANIFEST entries as JSON objects and write once at the end.
manifest_entries=()

# Pre-load any existing manifest entries for codes we won't touch this run.
if [[ -f "$MANIFEST" ]]; then
  while IFS= read -r entry; do
    manifest_entries+=("$entry")
  done < <(python3 - "$MANIFEST" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
for entry in data:
    print(json.dumps(entry))
PYEOF
)
fi

for code in "${DEPT_CODES[@]}"; do
  filename="adresses-${code}.csv"
  gz_file="$BAN_DIR/${filename}.gz"
  csv_file="$BAN_DIR/${filename}"
  url="${BASE_URL}/adresses-${code}.csv.gz"

  echo "=== dept $code"

  # If the CSV already exists, compare its sha256 against the manifest.
  if [[ -f "$csv_file" ]]; then
    existing_sha=$(sha256sum "$csv_file" | awk '{print $1}')
    recorded_sha="${MANIFEST_SHA[$code]:-}"
    if [[ -n "$recorded_sha" && "$existing_sha" == "$recorded_sha" ]]; then
      echo "  → already present + sha matches — skipping"
      skipped=$((skipped + 1))
      continue
    else
      echo "  → present but sha mismatch or no manifest entry — re-fetching"
      rm -f "$csv_file"
    fi
  fi

  # Download the gzipped CSV.
  if ! curl -fsSL --max-time 600 -o "$gz_file" "$url"; then
    echo "  ✗ download failed: $url"
    failed=$((failed + 1))
    failed_codes+=("$code")
    continue
  fi

  gz_size=$(stat -c '%s' "$gz_file" 2>/dev/null || stat -f '%z' "$gz_file")
  if [[ "$gz_size" -lt 1024 ]]; then
    echo "  ✗ response too small (${gz_size} bytes) — probable 404 / error page"
    rm -f "$gz_file"
    failed=$((failed + 1))
    failed_codes+=("$code")
    continue
  fi

  # Decompress in-place; delete the .gz.
  gunzip -f "$gz_file"
  rm -f "$gz_file"

  if [[ ! -f "$csv_file" ]]; then
    echo "  ✗ decompressed file not found at $csv_file"
    failed=$((failed + 1))
    failed_codes+=("$code")
    continue
  fi

  bytes=$(stat -c '%s' "$csv_file" 2>/dev/null || stat -f '%z' "$csv_file")
  sha=$(sha256sum "$csv_file" | awk '{print $1}')
  downloaded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  entry_json=$(python3 - "$code" "$filename" "$url" "$downloaded_at" "$sha" "$bytes" <<'PYEOF'
import json, sys
code, filename, url, downloaded_at, sha, bytes_ = sys.argv[1:]
print(json.dumps({
    "dept_code": code,
    "filename": filename,
    "source_url": url,
    "downloaded_at": downloaded_at,
    "sha256": sha,
    "bytes": int(bytes_),
}, ensure_ascii=False))
PYEOF
)
  # Replace any pre-loaded entry for this same code (re-fetch case).
  updated_entries=()
  for e in "${manifest_entries[@]}"; do
    e_code=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['dept_code'])" "$e")
    if [[ "$e_code" != "$code" ]]; then
      updated_entries+=("$e")
    fi
  done
  updated_entries+=("$entry_json")
  manifest_entries=("${updated_entries[@]}")

  echo "  ✓ $(numfmt --to=iec "$bytes" 2>/dev/null || echo "$bytes bytes")  sha256=$sha"
  fetched=$((fetched + 1))

  # Be a polite citizen — short pause between requests.
  sleep 0.2
done

# Write the consolidated MANIFEST.json.
python3 - "$MANIFEST" "${manifest_entries[@]}" <<'PYEOF'
import json, sys
manifest_path = sys.argv[1]
entries = [json.loads(e) for e in sys.argv[2:]]
entries.sort(key=lambda e: e["dept_code"])
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(entries, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"Wrote {manifest_path} with {len(entries)} entries.")
PYEOF

echo
echo "=== summary ==="
echo "fetched:  $fetched"
echo "skipped:  $skipped (already present + sha matched)"
echo "failed:   $failed"
if [[ ${#failed_codes[@]} -gt 0 ]]; then
  echo "failed codes: ${failed_codes[*]}"
fi
[[ "$failed" -eq 0 ]]
