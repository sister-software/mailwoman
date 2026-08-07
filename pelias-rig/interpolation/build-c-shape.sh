#!/bin/bash
# The multi-country interpolation build — run INSIDE the pelias/interpolation container.
#
# Why not `docker_build.sh`: it globs `${OSMPATH}/*.pbf` and `${POLYLINEPATH}/*.0sv` and uses only
# the ALPHABETICALLY FIRST of each, warning about the rest. It is single-country by construction, and
# there is no flag that changes that. So this drives `script/`'s pieces directly.
#
# THE ONE MERGED POLYLINE FILE IS NOT A CONVENIENCE, IT IS A CORRECTNESS REQUIREMENT. `api/polyline.js`
# assigns each street its id from `stream.polyline.autoincrement()` — the LINE NUMBER in the stream it
# is fed. `address.db`'s `id` column is that street id, and it is the only thing tying an address row
# to a street. Import the cuts as 19 separate passes and each pass restarts numbering at 1, so street
# 42 in Germany and street 42 in Vermont become the same street, and every address conflated against
# one lands on the other. One stream, one id space, one `street.db`. (The address side is safe to loop
# — see the note on the UNIQUE constraint below.)
#
# Pass order, and what each one is allowed to overwrite: `address.db`'s table carries
# `UNIQUE(id, housenumber) ON CONFLICT IGNORE`, so for a given street+housenumber the FIRST writer
# wins and every later pass is silently dropped. That makes pass ORDER a precedence decision, not a
# scheduling detail. OpenAddresses runs first because its rows are surveyed points; TIGER runs second
# because its rows are interpolated from address RANGES and should only fill what no point covers.
# Vertices runs last for the same reason — it synthesises fractional housenumbers at street geometry
# vertices, which is the weakest evidence of the three.
#
# Usage (inside the container):
#   BUILDDIR=/data/interpolation build-c-shape.sh <step>...
#   steps: clean polylines oa tiger vertices meta   (default: all of them, in that order)
set -uo pipefail
export LC_ALL=en_US.UTF-8

SCRIPTS=/code/pelias/interpolation/script
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export BUILDDIR=${BUILDDIR:-/data/interpolation}
export ADDRESS_DB="$BUILDDIR/address.db"
export STREET_DB="$BUILDDIR/street.db"
export SQLITE_TMPDIR="$BUILDDIR/tmp"
export POLYLINE_FILE=${POLYLINE_FILE:-/data/merged-19.0sv}
export OAPATH=${OAPATH:-/data/openaddresses}
export TIGERPATH=${TIGERPATH:-/data/tiger}
OA_LIST=${OA_LIST:-/scripts/oa-files.txt}
LEDGER="$BUILDDIR/pass-ledger.txt"

mkdir -p "$BUILDDIR" "$SQLITE_TMPDIR"

rows() { sqlite3 "$1" "SELECT COUNT(*) FROM $2;" 2>/dev/null || echo "?"; }

note() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LEDGER"; }

step_clean() {
	note "clean: removing street.db + address.db"
	rm -f "$STREET_DB" "$ADDRESS_DB" "$STREET_DB.gz" "$ADDRESS_DB.gz"
}

step_polylines() {
	note "polylines: START $POLYLINE_FILE ($(stat -c %s "$POLYLINE_FILE") bytes)"
	local t0=$(date +%s)
	"$SCRIPTS/import.sh"
	note "polylines: DONE rc=$? seconds=$(($(date +%s) - t0)) polyline=$(rows "$STREET_DB" polyline) names=$(rows "$STREET_DB" names) rtree=$(rows "$STREET_DB" rtree)"
}

# Looped per file so a single malformed CSV costs one country, not the pass — and so the per-file
# delta is recorded. `cmd/oa.js` opens and closes the databases itself on each invocation, which is
# what makes the loop safe.
step_oa() {
	note "oa: START $(grep -c . "$OA_LIST") files"
	local t0=$(date +%s)
	local before after single
	while IFS= read -r relative; do
		[ -n "$relative" ] || continue
		before=$(rows "$ADDRESS_DB" address)
		single=$(mktemp)
		echo "$relative" >"$single"
		"$HERE/concat-oa-list.sh" "$single" 2>>"$BUILDDIR/conflate_oa.err" |
			node "$SCRIPTS/../cmd/oa.js" "$ADDRESS_DB" "$STREET_DB" \
				1>>"$BUILDDIR/conflate_oa.out" 2>>"$BUILDDIR/conflate_oa.err" 3>>"$BUILDDIR/conflate_oa.skip"
		rm -f "$single"
		after=$(rows "$ADDRESS_DB" address)
		echo "  oa $relative before=$before after=$after" >>"$LEDGER"
	done <"$OA_LIST"
	note "oa: DONE seconds=$(($(date +%s) - t0)) address=$(rows "$ADDRESS_DB" address)"
}

# conflate_tiger.sh is ALREADY per-file — it globs `$TIGERPATH/downloads/**/*.zip` and pipes each
# county through ogr2ogr on its own. Our TIGER 2024 county zips mount straight in at that path, so
# this runs it unchanged rather than re-implementing the loop.
step_tiger() {
	local zips=$(find "$TIGERPATH/downloads" -type f -iname '*.zip' | wc -l)
	note "tiger: START $zips county zips before=$(rows "$ADDRESS_DB" address)"
	local t0=$(date +%s)
	"$SCRIPTS/conflate_tiger.sh"
	note "tiger: DONE rc=$? seconds=$(($(date +%s) - t0)) address=$(rows "$ADDRESS_DB" address)"
}

step_vertices() {
	note "vertices: START before=$(rows "$ADDRESS_DB" address)"
	local t0=$(date +%s)
	"$SCRIPTS/vertices.sh"
	note "vertices: DONE rc=$? seconds=$(($(date +%s) - t0)) address=$(rows "$ADDRESS_DB" address)"
}

step_meta() {
	note "meta: street polyline=$(rows "$STREET_DB" polyline) names=$(rows "$STREET_DB" names)"
	note "meta: address rows=$(rows "$ADDRESS_DB" address)"
	sqlite3 "$ADDRESS_DB" "SELECT source, COUNT(*) FROM address GROUP BY source ORDER BY 2 DESC;" |
		while IFS='|' read -r src n; do note "meta: address source=$src rows=$n"; done
}

STEPS=("$@")
[ ${#STEPS[@]} -gt 0 ] || STEPS=(clean polylines oa tiger vertices meta)

for step in "${STEPS[@]}"; do
	"step_$step"
done

note "build-c-shape: complete"
