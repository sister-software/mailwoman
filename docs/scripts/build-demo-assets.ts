#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   DEPRECATED — use the demo-assets Docusaurus plugin instead.
 *   The plugin (`docs/plugins/demo-assets/`) stages all assets automatically during `yarn build`.
 *   It reads `model-card.json` for version validation, builds the FST binary, and copies from
 *   `neural-weights-en-us`. This script is kept for manual intervention only.
 *
 *   Builds the static assets the `/demo` page needs:
 *
 *   - `docs/static/mailwoman/model.onnx`      (from `@mailwoman/neural-weights-en-us`)
 *   - `docs/static/mailwoman/tokenizer.model` (from `@mailwoman/neural-weights-en-us`)
 *
 *   The admin gazetteer (formerly the slim `wof-hot.db`) is RETIRED here — see the note below: it's
 *   now the global candidate table, built + hosted on R2 separately.
 *
 *   Run before `yarn build` if the assets are missing or stale. The Docusaurus build itself does NOT
 *   regenerate these — they're heavy artifacts kept out of git.
 *
 *   Replaces the bash `build-demo-assets.sh`: `node:fs` for staging, zx's `$` for the shell-out
 *   listing. The `$MAILWOMAN_DATA_ROOT` admin-gazetteer path routes through {@link dataRootPath};
 *   `PLAYPEN_WOF_ADMIN_DB` still overrides it.
 */

///<reference types="node" />

import { copyFile, mkdir, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { dataRootPath } from "@mailwoman/core/utils"
import { $ } from "zx"

const STATIC_DIR = fileURLToPath(new URL("../static/mailwoman", import.meta.url))
const WEIGHTS_PKG = fileURLToPath(new URL("../../neural-weights-en-us", import.meta.url))

// Canonical custom-built admin gazetteer (never the off-the-shelf geocode.earth dumps — see the
// feedback-custom-wof-db-only memory + scripts/wof-build-manifest.json) — the candidate-table source.
const WOF_ADMIN_DB = process.env["PLAYPEN_WOF_ADMIN_DB"] ?? dataRootPath("wof", "admin-global-priority.db")

/** Whether a path exists (file or symlink). */
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)

		return true
	} catch {
		return false
	}
}

async function main(): Promise<void> {
	await mkdir(STATIC_DIR, { recursive: true })

	const modelSrc = `${WEIGHTS_PKG}/model.onnx`
	process.stderr.write(`==> model.onnx (from ${modelSrc})\n`)

	if (!(await exists(modelSrc))) {
		process.stderr.write(`ERROR: ${modelSrc} missing.\n`)
		process.stderr.write("Run neural-weights-en-us/scripts/link-dev-weights.ts first or pass --weights.\n")
		process.exitCode = 1

		return
	}

	// `copyFile` follows symlinks at the source (the weights are dev-symlinked), matching `cp -L`.
	await copyFile(modelSrc, `${STATIC_DIR}/model.onnx`)

	const tokenizerSrc = `${WEIGHTS_PKG}/tokenizer.model`
	process.stderr.write(`==> tokenizer.model (from ${tokenizerSrc})\n`)
	await copyFile(tokenizerSrc, `${STATIC_DIR}/tokenizer.model`)

	// The admin gazetteer is RETIRED from this script (2026-06-20). The demo's admin tier no longer uses
	// the slim wof-hot.db — it byte-range-resolves against the global "candidate" table, which is built
	// separately and hosted version-independently on R2 (the candidate gazetteer is model-independent, so
	// it isn't a per-release static asset). Build + host it with:
	//
	//   node resolver-wof-sqlite/out/build-candidate-cli.js \
	//     --in  ${WOF_ADMIN_DB} \
	//     --postcodes $MAILWOMAN_DATA_ROOT/wof/postalcode-us.db \
	//     --out $MAILWOMAN_DATA_ROOT/wof/candidate-global.db
	//   # then upload to mailwoman/gazetteer/<ADMIN_GAZETTEER_VERSION>/candidate.db (see RELEASING.md)
	//
	// See RELEASING.md "Rebuilding + swapping the canonical admin gazetteer" + the candidate-table notes.

	process.stderr.write("\nDone. Static assets:\n")
	await $`ls -lh ${STATIC_DIR}/`

	// The candidate-table source the (separate) gazetteer build consumes — env-overridable via
	// PLAYPEN_WOF_ADMIN_DB, else under $MAILWOMAN_DATA_ROOT. Printed for the manual operator running
	// the RETIRED candidate recipe above.
	process.stderr.write(`\nadmin gazetteer source (for the candidate-table build): ${WOF_ADMIN_DB}\n`)
}

// Run main() only when invoked directly (the import-safe equivalent of Python's `if __name__ ==
// "__main__"`), so importing this module evaluates it without staging anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err: Error) => {
		process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
		process.exitCode = 1
	})
}
