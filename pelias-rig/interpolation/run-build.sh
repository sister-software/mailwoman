#!/usr/bin/env bash
# Host-side wrapper for the multi-country interpolation build. Starts the container with the mounts
# `build-c-shape.sh` expects and hands it the steps.
#
# It uses `podman run` rather than the compose `interpolation` service on purpose: that service is the
# long-running QUERY api (restart: always, port 4300), and a build is a one-shot with an extra mount
# the service has no reason to carry. Same image digest either way — the pin is read from
# `image-digests.txt`, not written here.
#
# The container runs as uid 1001 `pelias`, whose supplementary group is 1000 `ubuntu`; under
# `--userns=keep-id` that is the host user. So group-readable input works and owner-only (0600) does
# not — the same rule that cost the OpenAddresses import 68 minutes. Inputs here are all group- or
# world-readable; if that changes, this fails at the first file rather than silently skipping it.
#
# Usage: run-build.sh [step...]     # default: clean polylines oa tiger vertices meta
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RIG=/mnt/playpen/mailwoman-data/pelias-rig
IMAGE=$(awk '/pelias\/interpolation/{print $2}' "$RIG/project/image-digests.txt")

# Ship the current scripts + the OpenAddresses file list into the run location. pelias.json is the
# single source of that list, so interpolation and Elasticsearch cannot drift apart.
mkdir -p "$RIG/interp-scripts"
cp "$HERE/build-c-shape.sh" "$HERE/concat-oa-list.sh" "$RIG/interp-scripts/"
chmod +x "$RIG/interp-scripts"/*.sh
python3 -c "
import json
files = json.load(open('$RIG/project/pelias.json'))['imports']['openaddresses']['files']
open('$RIG/interp-scripts/oa-files.txt', 'w').write('\n'.join(files) + '\n')
print(len(files), 'openaddresses files')
"

exec podman run --rm --userns=keep-id \
	--name pelias_interpolation_build \
	-v "$RIG/data:/data" \
	-v /mnt/playpen/mailwoman-data/openaddresses/extracted:/data/openaddresses:ro \
	-v /mnt/playpen/mailwoman-data/tiger/2024:/data/tiger/downloads:ro \
	-v "$RIG/interp-scripts:/scripts:ro" \
	--entrypoint /bin/bash \
	"$IMAGE" \
	/scripts/build-c-shape.sh "$@"
