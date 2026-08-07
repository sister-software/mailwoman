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
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEST=/mnt/playpen/mailwoman-data/pelias-rig/project

mkdir -p "$DEST"

for f in docker-compose.yml elasticsearch.yml pelias.json; do
	cp "$HERE/$f" "$DEST/$f"
done

# `.env` is gitignored repo-wide, so `env.defaults` is the committed original.
[ -f "$DEST/.env" ] || cp "$HERE/env.defaults" "$DEST/.env"

echo "synced to $DEST"
sha256sum "$DEST/pelias.json"
