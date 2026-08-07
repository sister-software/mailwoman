#!/usr/bin/env bash
# Copy the version-controlled compose project to its RUN location at
# $MAILWOMAN_DATA_ROOT/pelias-rig/project/, and run compose from there.
#
# Why the copy exists at all: `docker-compose.yml` bind-mounts `./pelias.json` and
# `./elasticsearch.yml` by relative path, so the directory the compose command runs in becomes a
# path baked into every container. Running it straight out of a git worktree bakes the worktree path
# in — and agent worktrees under `.claude/worktrees/` are deleted when their agent finishes, which
# would leave a live Elasticsearch bind-mounting a directory that no longer exists. The data root is
# permanent; the worktree is not.
#
# The repo copy stays the source of truth. This script is the one-way sync, and re-running it after
# `build-config.ts` is how a regenerated `pelias.json` reaches the containers.
#
# Usage: pelias-rig/project/sync-project.sh
# REFUSES TO RUN MID-IMPORT, and the reason is not politeness about the config file.
#
# `bash` does not read a script into memory — it reads it incrementally and remembers a BYTE OFFSET.
# Overwrite a running script and the interpreter resumes at that offset in the new bytes, executing
# whatever fragment happens to live there. Measured on this rig: `run-import.sh` was re-copied while
# an import was in flight, and the ~40 lines inserted above the current execution point would have
# desynchronised everything after the `podman-compose run` — the refresh, the doc count, the ledger
# line, the rc the caller branches on. It was recovered by restoring the byte-identical old version
# (2537 bytes) before control returned.
#
# So the guard covers the SCRIPTS, and the config gets it for free: an importer that re-reads
# `pelias.json` mid-run would be reading a different build's file list.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEST=/mnt/playpen/mailwoman-data/pelias-rig/project

if [ "${1:-}" != "--force" ] && podman ps --format '{{.Names}}' | grep -qE 'project_(whosonfirst|openaddresses|openstreetmap|polylines)|pelias_interpolation_build'; then
	echo "refusing to sync: an importer is running — overwriting a script bash is mid-read of corrupts it"
	podman ps --format '  {{.Names}} {{.Status}}' | grep -E 'project_|pelias_'
	exit 1
fi

mkdir -p "$DEST"

for f in docker-compose.yml elasticsearch.yml pelias.json run-import.sh import-osm-per-country.sh es-inventory.py; do
	cp "$HERE/$f" "$DEST/$f"
done
chmod +x "$DEST"/*.sh

# `.env` is gitignored repo-wide, so `env.defaults` is the committed original.
[ -f "$DEST/.env" ] || cp "$HERE/env.defaults" "$DEST/.env"

echo "synced to $DEST"
sha256sum "$DEST/pelias.json"
