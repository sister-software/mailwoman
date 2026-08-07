#!/usr/bin/env bash
# Import the country PBFs ONE AT A TIME, each with its own config and its own ledger line.
#
# `imports.openstreetmap.import` is a list, and the importer will happily walk all ten in a single
# container run. It should not. The run is the long pole of the whole build — germany alone is
# 4.81 GB of PBF — and a single run is a single failure unit: anything that kills it at file eight
# throws away files one through seven with it, and the log gives no per-country boundary to resume
# from. We have already paid that bill once on this rig, when OpenAddresses died 68 minutes in on a
# permission error and left 32 million documents that no count could distinguish from a good import.
#
# So: one container per country, one line in the ledger per country, and a marker file so a re-run
# skips what already landed. The generated per-country configs are written next to the real
# `pelias.json` and are disposable — `build-config.ts` owns the real one and never reads these.
#
# The nine US state PBFs are not in `imports.openstreetmap.import` at all (§1: the US row is
# `TIGER+OA, no OSM`); `build-config.ts` holds them out, so this loop cannot pick them up by accident.
#
# Usage: import-osm-per-country.sh [country-slug...]   # default: every file in the config's list
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOGS=/mnt/playpen/mailwoman-data/pelias-rig/logs
MARK=/mnt/playpen/mailwoman-data/pelias-rig/markers
LEDGER="$LOGS/import-ledger.txt"
ES=http://localhost:9200
mkdir -p "$LOGS" "$MARK"

mapfile -t FILES < <(python3 -c "
import json
for entry in json.load(open('$HERE/pelias.json'))['imports']['openstreetmap']['import']:
    print(entry['filename'])
")

if [ $# -gt 0 ]; then
	WANT=("$@")
else
	WANT=("${FILES[@]}")
fi

count() { curl -sf "$ES/pelias/_count" | sed -n 's/.*"count":\([0-9]*\).*/\1/p'; }

for filename in "${WANT[@]}"; do
	slug=${filename%-latest.osm.pbf}

	if [ -f "$MARK/OSM-IMPORT-$slug-DONE" ]; then
		echo "skip $slug (marker present)"
		continue
	fi

	config="$HERE/pelias.osm-$slug.json"
	python3 -c "
import json
config = json.load(open('$HERE/pelias.json'))
config['imports']['openstreetmap']['import'] = [{'filename': '$filename'}]
json.dump(config, open('$config', 'w'), indent=2)
"

	before=$(count)
	start=$(date +%s)
	echo "== osm/$slug start $(date -u +%FT%TZ) before=$before"

	cd "$HERE"
	podman run --rm --userns=keep-id \
		--network project_default --network-alias openstreetmap \
		-v "$config:/code/pelias.json:ro" \
		-v /mnt/playpen/mailwoman-data/pelias-rig/data:/data \
		"$(awk '/pelias\/openstreetmap/{print $2}' "$HERE/image-digests.txt")" \
		npm start >"$LOGS/import-osm-$slug.log" 2>&1
	rc=$?

	curl -sf -XPOST "$ES/pelias/_refresh" >/dev/null
	after=$(count)
	echo "osm/$slug rc=$rc seconds=$(($(date +%s) - start)) before=$before after=$after delta=$((after - before))" | tee -a "$LEDGER"

	if [ "$rc" -eq 0 ]; then
		touch "$MARK/OSM-IMPORT-$slug-DONE"
	else
		echo "STOPPING: osm/$slug exited rc=$rc — see $LOGS/import-osm-$slug.log"
		exit 1
	fi
done

echo "osm per-country import complete"
