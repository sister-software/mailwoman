#!/bin/bash
# @copyright Sister Software
# @license AGPL-3.0
#
# Multi-region interp-radius conformal sweep (#374/C). For each state: synthesize a situs-ground-truth
# holdout, run conformal-calibrate.ts INTERP-ONLY (situs no-op'd via an empty tableless DB → the #568
# guard), and print the per-state Q̂ + coverage. The situs (OA/NAD) vs interp (TIGER) provenance split
# makes this non-circular for any state. See docs/articles/evals/2026-06-14-interp-multiregion-recalibration.md.
#
# Usage: scripts/eval/run-conformal-multistate.sh [STATE_SLUGS...]   (default: mi ny ca mt)
set -euo pipefail
cd "$(dirname "$0")/../.."

AP=/mnt/playpen/mailwoman-data/address-points
IP=/mnt/playpen/mailwoman-data/interpolation
EMPTY=/tmp/empty-situs.db
N=${CONFORMAL_N:-2000}
STATES=("${@:-mi ny ca mt}")

# Empty tableless situs DB so the situs tier is a no-op (interp-only). readOnly can't create it, so make it here.
node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('$EMPTY'); d.exec('CREATE TABLE IF NOT EXISTS _placeholder (x)'); d.close();"

for slug in ${STATES[@]}; do
	reg=$(echo "$slug" | tr '[:lower:]' '[:upper:]')
	echo "######## $reg ########"
	node scripts/eval/build-situs-holdout.mjs --shard "$AP/address-points-us-$slug.db" --region "$reg" --n "$N" >/dev/null
	node --experimental-strip-types scripts/eval/conformal-calibrate.ts \
		--holdout "/tmp/$slug-situs-holdout.jsonl" \
		--address-points "$EMPTY" \
		--interpolation "$IP/interpolation-us-$slug.db" \
		2>/dev/null | grep -E "resolved :|combined conformal threshold|empirical coverage on test|uncalibrated coverage|interpolated "
	echo ""
done
