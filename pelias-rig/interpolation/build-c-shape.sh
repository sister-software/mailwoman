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
# THE ADDRESS TABLE'S KEY IS NOT A BARE `id`, so there is nothing to namespace. It is
# `rowid INTEGER PRIMARY KEY` — a surrogate — with `source` and `source_id` carrying provenance in
# their own columns, so two sources cannot collide on a record identifier. Namespacing the inputs
# would in fact be wrong: `id` is the STREET id, a reference into `street.db`, and rewriting it would
# sever the join.
#
# What the table DOES carry is `UNIQUE(id, housenumber) ON CONFLICT IGNORE`: for a given
# street+housenumber the FIRST writer wins and every later pass is dropped in silence. That makes pass
# ORDER a precedence decision, not a scheduling detail. OpenAddresses runs first because its rows are
# surveyed points; TIGER second because its rows are interpolated from address RANGES and should only
# fill what no point covers; vertices last, because it synthesises fractional housenumbers at street
# geometry vertices and that is the weakest evidence of the three.
#
# MEASURED on the DC slice (3,384 streets, one TIGER county, one OA file), building twice off the same
# street.db: TIGER alone yields 44,504 address rows; TIGER after OpenAddresses yields 32,774. The
# conflict drops 11,730 rows, 26.4% of TIGER's output, and every one of them is a street+housenumber
# OpenAddresses already covered. Sampling five of the collisions, the OA point sits 17.5–53.2 m from
# the TIGER interpolation it displaced (mean 31.1 m) — which is the whole argument for this order in
# one number: reverse it and those 11,730 DC addresses answer from a range interpolation roughly 31 m
# off instead of from the surveyed point, and §3's 50 m rooftop bar starts depending on which pass ran
# first.
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
