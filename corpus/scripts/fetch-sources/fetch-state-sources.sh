#!/usr/bin/env bash
# Re-fetch the state-level open-data sources tonight's adhoc download pulled
# (NY/TX/DE/OR notaries, IA contractors, WA health providers, HI lobbyists).
# Reproducible recovery if /mnt/playpen/mailwoman-data is lost.
#
# HI public schools is fetched separately by `fetch-state-hi-schools.sh` —
# its upstream is an XLSX workbook that requires an openpyxl-driven
# sheet-concatenation pre-step before the adapter can consume it.
#
# Each source lands in its own subdirectory of $OUT_ROOT/$source_slug/ along
# with a MANIFEST.json recording origin URL + download timestamp + sha256 so
# downstream adapters can verify provenance.
#
# Usage:
#   OUT_ROOT=/data/corpus/sources packages/corpus/scripts/fetch-sources/fetch-state-sources.sh
#
# Defaults to writing under ./data/corpus/sources/ in the repo root.

set -euo pipefail

OUT_ROOT=${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}
mkdir -p "$OUT_ROOT"

# slug | filename | source-url
SOURCES=(
	"state-ny-notaries|NY_Commissioned_Notaries.csv|https://data.ny.gov/api/views/rwbv-mz6z/rows.csv?accessType=DOWNLOAD"
	"state-tx-notaries|TX_Notary_Public_Commissions.csv|https://data.texas.gov/api/views/gmd3-bnrd/rows.csv?accessType=DOWNLOAD"
	"state-de-notaries|DE_Notaries_Commissioned.csv|https://data.delaware.gov/api/views/q8dr-mj6p/rows.csv?accessType=DOWNLOAD"
	"state-or-notaries|OR_Active_Notaries.csv|https://data.oregon.gov/api/views/j2pk-zk6z/rows.csv?accessType=DOWNLOAD"
	"state-ia-contractors|IA_Active_Construction_Contractor_Registrations.csv|https://data.iowa.gov/api/views/dpf3-iz94/rows.csv?accessType=DOWNLOAD"
	"state-wa-health-providers|WA_Health_Care_Provider_Credential_Data.csv|https://data.wa.gov/api/views/qxh8-f4bd/rows.csv?accessType=DOWNLOAD"
	"state-hi-lobbyists|HI_Lobbyist_Registration_Statements.csv|https://data.hawaii.gov/api/views/cm7c-skav/rows.csv?accessType=DOWNLOAD"
)

fetched=0
failed=0
for entry in "${SOURCES[@]}"; do
	IFS='|' read -r slug filename url <<<"$entry"
	dest_dir="$OUT_ROOT/$slug"
	mkdir -p "$dest_dir"
	dest="$dest_dir/$filename"

	echo "=== $slug / $filename"
	if ! curl -fsSL --max-time 600 -o "$dest" "$url"; then
		echo "  ✗ download failed for $url"
		failed=$((failed + 1))
		continue
	fi

	size=$(stat -c '%s' "$dest" 2>/dev/null || stat -f '%z' "$dest")
	if [ "$size" -lt 1024 ]; then
		echo "  ✗ response too small ($size bytes) — probable 404 / error page"
		failed=$((failed + 1))
		continue
	fi

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
	fetched=$((fetched + 1))
done

echo
echo "=== summary ==="
echo "fetched: $fetched"
echo "failed:  $failed"
[ "$failed" -eq 0 ]
