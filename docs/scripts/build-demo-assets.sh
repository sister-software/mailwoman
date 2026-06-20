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
# The admin gazetteer (formerly the slim wof-hot.db) is RETIRED here — see the note below: it's now
# the global candidate table, built + hosted on R2 separately.
#
# Run before `yarn build` if the assets are missing or stale. The Docusaurus build itself does NOT
# regenerate these — they're heavy artifacts kept out of git.

set -euo pipefail

cd "$(dirname "$0")/.."

DOCS_ROOT="$(pwd)"
STATIC_DIR="${DOCS_ROOT}/static/mailwoman"
REPO_ROOT="$(cd "${DOCS_ROOT}/.." && pwd)"
WEIGHTS_PKG="${REPO_ROOT}/neural-weights-en-us"

# Canonical custom-built admin gazetteer (never the off-the-shelf geocode.earth dumps — see the
# feedback-custom-wof-db-only memory + scripts/wof-build-manifest.json) — the candidate-table source.
WOF_ADMIN_DB="${PLAYPEN_WOF_ADMIN_DB:-/mnt/playpen/mailwoman-data/wof/admin-global-priority.db}"

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

# The admin gazetteer is RETIRED from this script (2026-06-20). The demo's admin tier no longer uses
# the slim wof-hot.db — it byte-range-resolves against the global "candidate" table, which is built
# separately and hosted version-independently on R2 (the candidate gazetteer is model-independent, so
# it isn't a per-release static asset). Build + host it with:
#
#   node resolver-wof-sqlite/out/build-candidate-cli.js \
#     --in  ${WOF_ADMIN_DB} \
#     --postcodes /mnt/playpen/mailwoman-data/wof/postalcode-us.db \
#     --out /mnt/playpen/mailwoman-data/wof/candidate-global.db
#   # then upload to mailwoman/gazetteer/<ADMIN_GAZETTEER_VERSION>/candidate.db (see RELEASING.md)
#
# See RELEASING.md "Rebuilding + swapping the canonical admin gazetteer" + the candidate-table notes.

echo
echo "Done. Static assets:"
ls -lh "${STATIC_DIR}/"
