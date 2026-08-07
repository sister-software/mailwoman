#!/usr/bin/env bash
# Run ONE Pelias importer and record what it did — wall time, and the Elasticsearch doc count before
# and after. That before/after pair is the audit trail the preregistration asks for: an importer that
# exits 0 having indexed nothing is the failure mode that looks like success, and the only thing that
# distinguishes it from a real import is the delta.
#
# Importers run STRICTLY ONE AT A TIME (§1 memory discipline, 29 GB host). This script does not
# enforce that — it refuses to help you break it either, so run it serially.
#
# THE COMMAND IS NOT OPTIONAL, and getting that wrong looks like success. Every pelias importer
# image has `bash` as its default CMD, so `podman-compose run --rm whosonfirst` with no command does
# not import — it opens an interactive shell and sits there. Measured: it ran for 30 seconds against
# an empty index, `podman ps` showed it Up, and the ES count stayed at 0. So this script carries the
# per-service command itself and a caller cannot omit it.
#
# Usage: run-import.sh <service> [args-that-override-the-default...]
#   run-import.sh whosonfirst
#   run-import.sh openaddresses
#   run-import.sh openstreetmap
#   run-import.sh polylines
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOGS=/mnt/playpen/mailwoman-data/pelias-rig/logs
LEDGER="$LOGS/import-ledger.txt"
ES=http://localhost:9200
mkdir -p "$LOGS"

SERVICE=${1:?usage: run-import.sh <service> [args...]}
shift

# Every importer's real entry point is `npm start` (-> ./bin/start). Kept as a map rather than a
# constant so a service that ever needs different args has a place to say so.
declare -A DEFAULT_CMD=(
	[whosonfirst]="npm start"
	[openaddresses]="npm start"
	[openstreetmap]="npm start"
	[polylines]="npm start"
)

if [ $# -eq 0 ]; then
	read -r -a CMD <<<"${DEFAULT_CMD[$SERVICE]:?no default command known for service '$SERVICE' — pass one}"
else
	CMD=("$@")
fi

count() { curl -sf "$ES/pelias/_count" | sed -n 's/.*"count":\([0-9]*\).*/\1/p'; }

before=$(count)
start=$(date +%s)
echo "== $SERVICE start $(date -u +%FT%TZ) before=$before cmd=${CMD[*]}"

cd "$HERE"
podman-compose run --rm "$SERVICE" "${CMD[@]}" >"$LOGS/import-$SERVICE.log" 2>&1
rc=$?

# The refresh interval is 10s (pelias.json); force one so the count reflects the import rather than
# the clock.
curl -sf -XPOST "$ES/pelias/_refresh" >/dev/null
after=$(count)
dur=$(($(date +%s) - start))

echo "$SERVICE rc=$rc seconds=$dur before=$before after=$after delta=$((after - before))" | tee -a "$LEDGER"
