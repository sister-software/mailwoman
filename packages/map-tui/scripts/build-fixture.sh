#!/usr/bin/env bash
# Regenerates portland.pmtiles from the hand-authored GeoJSON sources.
# Requires tippecanoe (https://github.com/felt/tippecanoe). The output is
# COMMITTED so tests and CI never need tippecanoe installed.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"

tippecanoe -o portland.pmtiles --force -Z0 -z15 \
	--no-tile-size-limit \
	--no-tiny-polygon-reduction \
	-L earth:src/earth.geojson \
	-L water:src/water.geojson \
	-L roads:src/roads.geojson \
	-L boundaries:src/boundaries.geojson \
	-L places:src/places.geojson
