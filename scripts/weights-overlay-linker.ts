/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The dev-weights build every PAIR-INDEX-ONLY weights overlay runs, in one place.
 *
 *   WHY THIS EXISTS. An overlay that declares `mailwoman.baseWeights` ships exactly one artifact and
 *   symlinks nothing, so its `scripts/link-dev-weights.ts` was ~117 lines of identical machinery
 *   differing only in a two-letter country code. `scaffold-weights-overlay.ts` used to end by telling
 *   the author to "copy the closest sibling's build block", and that instruction did what copy
 *   instructions do: `es-es` and `it-it` both shipped `de-de`'s docstring, telling the reader the
 *   index is inert without the `de` entries because "German addresses write 50733 Köln". The code was
 *   correct in both. Everything a reader would use to CHECK the code named the wrong country, and
 *   nothing catches that, because the script works.
 *
 *   So the machinery lives here and an overlay supplies a manifest. There is no build block left to
 *   copy, and the prose that remains in each overlay is the part that is genuinely per-locale.
 *
 *   NOT for the base packages. `en-us`, `en-gb`, `en-nz` and `fr-fr` symlink a model and tokenizer,
 *   verify md5s against their model card, and build several artifacts apiece; they legitimately
 *   differ and stay hand-written. This covers the overlay shape only, and refuses anything else by
 *   construction — it takes a country code and builds one pair index.
 *
 *   Callers are dev-only and excluded from the published tarball (`!scripts/**`), which is what lets
 *   an overlay script import this file by relative path.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * What one pair-index overlay has to say about itself. Everything else is shared.
 */
export interface PairIndexOverlay {
	/**
	 * Workspace directory name, e.g. `neural-weights-de-de`.
	 */
	packageDir: string
	/**
	 * ISO country code passed to `gazetteer pair-index --country`, and the suffix of the built artifact (`de` →
	 * `pair-index-de.bin`). NOT the locale tag: `en-in` builds `pair-index-in.bin`.
	 */
	country: string
	/**
	 * Calibrated magnitudes the locale's bars were measured at. Baked into the artifact's PIX1 header, which is how the
	 * freshness check below notices a change to either.
	 */
	delta: number
	transitionBeta: number
}

/**
 * Minimal PIX1 header reader — magic + header only, reimplemented so a data-only overlay gains no dependency on
 * `@mailwoman/neural` (which pulls onnxruntime-node) to read two fields.
 */
function peekPairIndexHeaderFields(path: string): {
	delta: number
	transitionBeta: number | undefined
	schemaVersion: number
} {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)

	const header = parseJSONStrict<{
		delta: number
		transitionBeta?: number
		schemaVersion: number
	}>(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8"))

	return { delta: header.delta, transitionBeta: header.transitionBeta, schemaVersion: header.schemaVersion }
}

/**
 * The PIX1 schema this tree's reader requires (`neural/pair-index-resolver.ts` KNOWN_SCHEMA_VERSION). The freshness
 * guard must compare it: a guard that checks only delta + source md5 reads a format-obsolete binary as "current" and
 * leaves every dev checkout with artifacts the runtime refuses — the R5 freshness-guard lesson, format edition.
 */
const REQUIRED_PAIR_INDEX_SCHEMA = 2

/**
 * Build `pair-index-<country>.bin` into the overlay, skipping the work when the artifact on disk was already built at
 * these magnitudes.
 *
 * Exits non-zero on a failed build. Missing INPUTS (an unbuilt CLI, an absent WOF database) warn and return instead: a
 * fresh clone has neither, and `yarn test` invokes this to verify auto-resolve, so a hard failure there would be a
 * failure to have run a build yet rather than a real fault.
 */
export function buildPairIndexOverlay({ packageDir, country, delta, transitionBeta }: PairIndexOverlay): void {
	const PKG_DIR = String(repoRootPath(packageDir))
	const CLI = String(repoRootPath("mailwoman", "out", "cli.js"))
	const ARTIFACT = `pair-index-${country}.bin`
	const DEST = resolve(PKG_DIR, ARTIFACT)
	/**
	 * Checked-in WOF-derived admin pairs — the same posture as the GB secondary sources.
	 */
	const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))

	if (!existsSync(CLI)) {
		console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for ${ARTIFACT}.`)

		return
	}

	if (!existsSync(WOF_ADMIN_DB)) {
		console.error(`WARNING: missing ${WOF_ADMIN_DB} — ${ARTIFACT} not built.`)

		return
	}

	if (existsSync(DEST)) {
		try {
			const header = peekPairIndexHeaderFields(DEST)

			if (header.schemaVersion !== REQUIRED_PAIR_INDEX_SCHEMA) {
				console.log(`rebuilding ${ARTIFACT} — schemaVersion ${header.schemaVersion} → ${REQUIRED_PAIR_INDEX_SCHEMA}`)
			} else if (header.delta !== delta) {
				console.log(`rebuilding ${ARTIFACT} — delta ${header.delta} → ${delta}`)
			} else if (header.transitionBeta !== transitionBeta) {
				console.log(`rebuilding ${ARTIFACT} — transitionBeta ${header.transitionBeta} → ${transitionBeta}`)
			} else {
				console.log(`skipped ${ARTIFACT} build — ${DEST} is current`)

				return
			}
		} catch (error) {
			console.log(`rebuilding ${ARTIFACT} — header unreadable (${(error as Error).message})`)
		}
	}

	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"gazetteer",
			"pair-index",
			"--out",
			PKG_DIR,
			"--country",
			country,
			"--delta",
			String(delta),
			"--transition-beta",
			String(transitionBeta),
			"--borough-db",
			WOF_ADMIN_DB,
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(DEST)) {
		console.error(`FAILED: gazetteer pair-index --country ${country} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${ARTIFACT} ← ${WOF_ADMIN_DB}`)
}
