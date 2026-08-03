/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-es-es` (hierarchy campaign R11).
 *
 *   This overlay ships exactly ONE artifact — `pair-index-es.bin` — because it declares
 *   `mailwoman.baseWeights` and shares the base model/tokenizer with the en-us package. There is
 *   nothing to symlink; the only job is building the index so `resolveWeights({locale: "es-es"})`
 *   surfaces `pairIndexPath` in local dev.
 *
 *   The index is INERT without the `es` entries in `SEGMENT_PARENT_POSTCODE_SHAPES` and
 *   `LEADING_POSTCODE_COUNTRIES` (`neural/placetype-pair-prior.ts`): Spanish addresses write the
 *   codigo postal first ("28013 Madrid"), so a parent segment folds to a key no bare-municipio
 *   entry matches. The artifact alone changes nothing until both entries are present.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = String(repoRootPath("neural-weights-es-es"))
const CLI = String(repoRootPath("mailwoman", "out", "cli.js"))
const PAIR_INDEX_BIN_DEST = resolve(PKG_DIR, "pair-index-es.bin")
/**
 * Checked-in WOF-derived (Ortsteil, Gemeinde) pairs — the same posture as the GB secondary sources.
 */
const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
/**
 * Calibrated magnitudes — the pair the R11 bars were measured at (0/60 confound FPs).
 */
const PAIR_INDEX_DELTA = 10
const PAIR_INDEX_TRANSITION_BETA = 5

/**
 * Minimal PIX1 header reader — magic + header only, reimplemented so this data-only package gains no dependency on
 * `@mailwoman/neural` (which pulls onnxruntime-node) to read two fields.
 */
function peekPairIndexHeaderFields(path: string): { delta: number; transitionBeta: number | undefined } {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)
	const header = JSON.parse(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8")) as {
		delta: number
		transitionBeta?: number
	}

	return { delta: header.delta, transitionBeta: header.transitionBeta }
}

if (!existsSync(CLI)) {
	console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for pair-index-es.bin.`)
} else if (!existsSync(WOF_ADMIN_DB)) {
	console.error(`WARNING: missing ${WOF_ADMIN_DB} — pair-index-es.bin not built.`)
} else {
	let needsRebuild = true

	if (existsSync(PAIR_INDEX_BIN_DEST)) {
		try {
			const header = peekPairIndexHeaderFields(PAIR_INDEX_BIN_DEST)

			if (header.delta !== PAIR_INDEX_DELTA) {
				console.log(`rebuilding pair-index-es.bin — delta ${header.delta} → ${PAIR_INDEX_DELTA}`)
			} else if (header.transitionBeta !== PAIR_INDEX_TRANSITION_BETA) {
				console.log(
					`rebuilding pair-index-es.bin — transitionBeta ${header.transitionBeta} → ${PAIR_INDEX_TRANSITION_BETA}`
				)
			} else {
				needsRebuild = false
			}
		} catch (error) {
			console.log(`rebuilding pair-index-es.bin — header unreadable (${(error as Error).message})`)
		}
	}

	if (!needsRebuild) {
		console.log(`skipped pair-index-es.bin build — ${PAIR_INDEX_BIN_DEST} is current`)
	} else {
		const result = spawnSync(
			process.execPath,
			[
				CLI,
				"gazetteer",
				"pair-index",
				"--out",
				PKG_DIR,
				"--country",
				"es",
				"--delta",
				String(PAIR_INDEX_DELTA),
				"--transition-beta",
				String(PAIR_INDEX_TRANSITION_BETA),
				"--borough-db",
				WOF_ADMIN_DB,
			],
			{ stdio: "inherit" }
		)

		if (result.status !== 0 || !existsSync(PAIR_INDEX_BIN_DEST)) {
			console.error(`FAILED: gazetteer pair-index --country es (exit ${result.status})`)

			process.exit(1)
		}

		console.log(`built pair-index-es.bin ← ${WOF_ADMIN_DB}`)
	}
}
