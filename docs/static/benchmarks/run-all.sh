#!/usr/bin/env bash
#
# run-all.sh — pull the data the published panels need, run both, write the result JSON.
#
# This is the whole re-run promise in one file. Everything the benchmark pages report comes out of
# these two commands, and the numbers on the pages are the contents of the two JSON files this
# writes.
#
# WHAT IT DOWNLOADS
#
#   candidate   the global admin gazetteer, about 1.65 GB. Both panels need it.
#   fr          the French BAN rooftop shard, about 6.95 GB. The French panel needs it; the Belgian
#               panel does not.
#
# That is roughly 8.6 GB before either panel runs. Downloads land under the data root and are skipped
# when a copy is already there, so a second run costs nothing.
#
# USAGE
#
#   ./run-all.sh                      # into ./benchmark-data, or $MAILWOMAN_DATA_ROOT when set
#   ./run-all.sh /path/to/data-root   # into a root you name
#
# The panels resolve `mailwoman` and the `@mailwoman/*` packages from the working directory's
# node_modules, so run this from a project that has them installed:
#
#   npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us \
#               @mailwoman/neural-weights-fr-fr @mailwoman/resolver \
#               @mailwoman/resolver-wof-sqlite @mailwoman/ban @mailwoman/core @mailwoman/spatial

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT="${1:-${MAILWOMAN_DATA_ROOT:-$PWD/benchmark-data}}"

mkdir -p "$DATA_ROOT"

echo "==> data root: $DATA_ROOT"
npx mailwoman data pull candidate fr --data-root "$DATA_ROOT"

echo
echo "==> France — 100 BAN addresses, two surface forms"
node "$HERE/fr-ban-panel.mjs" --data-root "$DATA_ROOT" --out "$HERE/fr-ban-results.json"

echo
echo "==> Belgium — 30 addresses, three configurations"
node "$HERE/be-panel.mjs" --data-root "$DATA_ROOT" --out "$HERE/be-results.json"

echo
echo "==> results"
echo "    $HERE/fr-ban-results.json"
echo "    $HERE/be-results.json"
