#!/bin/bash
# `pelias/interpolation`'s `script/concat_oa.sh`, with the file DISCOVERY replaced by an explicit
# list. Everything downstream of the `find` — the header handling, the CRLF strip, the quoted-newline
# awk, the HASH synthesis, the filename prefix, the sort, the uniq — is byte-identical to upstream,
# because that pipeline is what `cmd/oa.js` is written against and a paraphrase of it is a data bug
# waiting to happen.
#
# The `find` has to go because it takes EVERY csv under OAPATH. Our OpenAddresses tree is the shared
# `$MAILWOMAN_DATA_ROOT/openaddresses/extracted` — 36 countries, only ten of which are in the panel —
# and it holds both `countrywide.csv` and the smaller region files that repeat its rows. `pelias.json`
# already resolves both questions (10 in-scope countries, countrywide-only where one exists, plus the
# 9 US panel states), so the same list drives interpolation and Elasticsearch. Two importers reading
# one list is the point: a divergence between them shows up as an interpolation gap that looks like a
# data problem.
#
# Usage: concat-oa-list.sh <list-file>     # one path per line, relative to $OAPATH
set -e
export LC_ALL=en_US.UTF-8

OAPATH=${OAPATH:-"/data/openaddresses"}
LIST=${1:?usage: concat-oa-list.sh <list-file>}

HAS_OUTPUT_HEADER=false

while IFS= read -r relative; do
	[ -n "$relative" ] || continue
	filename="$OAPATH/$relative"
	if [ ! -f "$filename" ]; then
		echo >&2 "MISSING $filename"
		continue
	fi

	if [ "$HAS_OUTPUT_HEADER" = false ]; then
		HAS_OUTPUT_HEADER=true
		head -n1 "$filename" | sed $'s/\r//'
	fi

	echo >&2 "$(date -u) $filename"

	HASH_PREFIX="${relative%.*}"

	tail -n +2 "$filename" |
		sed $'s/\r//' |
		awk -v RS='"' 'NR % 2 == 0 { gsub(/\r?\n|\r/, " ") } { printf("%s%s", $0, RT) }' |
		awk -F ',' 'BEGIN { OFS = "," } { if( length($NF) < 2 ) $NF = sprintf( "%d", NR ); print }' |
		awk -F',' -v prefix="$HASH_PREFIX" 'BEGIN { OFS = "," } { $NF = sprintf( "%s:%s", prefix, $NF ); print }' |
		sort -t, -k 4,4d -k 6,6d -k 7,7d -k 8,8d -k 3,3n |
		uniq
done <"$LIST"
