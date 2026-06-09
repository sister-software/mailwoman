#!/usr/bin/env bash
#
# DEPRECATED — use the demo-assets Docusaurus plugin instead.
# The plugin (docs/plugins/demo-assets/) stages all assets automatically during `yarn build`.
# It reads model-card.json for version validation, builds the FST binary, and copies from
# neural-weights-en-us. This script is kept for manual intervention only.
#
# Builds the static assets the /demo page needs:
#   - docs/static/mailwoman/model.onnx        (from @mailwoman/neural-weights-en-us)
#   - docs/static/mailwoman/tokenizer.model   (from @mailwoman/neural-weights-en-us)
#   - docs/static/mailwoman/wof-hot.db        (slim WOF distribution; built via mailwoman-wof-build-slim)
#
# Run before `yarn build` if the assets are missing or stale. The Docusaurus build itself does NOT
# regenerate these — they're heavy artifacts kept out of git.

set -euo pipefail

cd "$(dirname "$0")/.."

DOCS_ROOT="$(pwd)"
STATIC_DIR="${DOCS_ROOT}/static/mailwoman"
REPO_ROOT="$(cd "${DOCS_ROOT}/.." && pwd)"
WEIGHTS_PKG="${REPO_ROOT}/neural-weights-en-us"
SLIM_CLI="${REPO_ROOT}/resolver-wof-sqlite/out/build-slim-cli.js"

# WOF source paths. Override via env (PLAYPEN_WOF_ADMIN_DB / PLAYPEN_WOF_POSTCODE_DB) for non-host
# environments.
# Canonical custom-built gazetteer (never the off-the-shelf geocode.earth dumps — see the
# feedback-custom-wof-db-only memory + scripts/wof-build-manifest.json). Admin-only today.
WOF_ADMIN_DB="${PLAYPEN_WOF_ADMIN_DB:-/mnt/playpen/mailwoman-data/wof/admin-global-priority.db}"
# Postcodes: no custom postcode DB yet (the off-the-shelf postalcode dump was deleted). Set
# PLAYPEN_WOF_POSTCODE_DB once a custom postcode DB is built to re-enable the postcode slice.
WOF_POSTCODE_DB="${PLAYPEN_WOF_POSTCODE_DB:-}"

mkdir -p "${STATIC_DIR}"

echo "==> model.onnx (from ${WEIGHTS_PKG}/model.onnx)"
if [[ ! -e "${WEIGHTS_PKG}/model.onnx" ]]; then
    echo "ERROR: ${WEIGHTS_PKG}/model.onnx missing." >&2
    echo "Run neural-weights-en-us/scripts/link-dev-weights.sh first or pass --weights." >&2
    exit 1
fi
cp -L "${WEIGHTS_PKG}/model.onnx" "${STATIC_DIR}/model.onnx"

echo "==> tokenizer.model (from ${WEIGHTS_PKG}/tokenizer.model)"
cp -L "${WEIGHTS_PKG}/tokenizer.model" "${STATIC_DIR}/tokenizer.model"

# `--countries` MUST include every country the demo resolves, AND it gates which `coincident_roles`
# survive the slim filter (the relation is dropped for any place whose spr row is trimmed). DE/FR carry
# the city-states the dual-role badge surfaces (Berlin/Hamburg/Bremen, Paris) — a US-only slim has zero
# coincident roles, so the badge would never appear. Override via SLIM_COUNTRIES.
SLIM_COUNTRIES="${SLIM_COUNTRIES:-US,DE,FR}"
echo "==> wof-hot.db (slim WOF, top-${SLIM_TOP_LOCALITIES:-1000} localities/country in ${SLIM_COUNTRIES} + all postcodes + coincident_roles)"
if [[ ! -e "${SLIM_CLI}" ]]; then
    echo "build-slim-cli not compiled — running yarn compile first."
    (cd "${REPO_ROOT}" && yarn compile)
fi
# --drop-names: the resolver never reads the names table at runtime (self-contained FTS5), so drop it
# for a ~2/3 size win on the shipped DB (see #359).
node "${SLIM_CLI}" \
    --in "${WOF_ADMIN_DB}" \
    --in "${WOF_POSTCODE_DB}" \
    --out "${STATIC_DIR}/wof-hot.db" \
    --top "${SLIM_TOP_LOCALITIES:-1000}" \
    --countries "${SLIM_COUNTRIES}" \
    --drop-names

echo
echo "Done. Static assets:"
ls -lh "${STATIC_DIR}/"
