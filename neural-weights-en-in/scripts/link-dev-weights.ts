/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-en-in` (hierarchy campaign R10).
 *
 *   This overlay ships exactly ONE artifact — `pair-index-in.bin` — because it declares
 *   `mailwoman.baseWeights` and shares the base model/tokenizer with the en-us package. There is
 *   nothing to symlink; the only job is building the index so `resolveWeights({locale: "en-in"})`
 *   surfaces `pairIndexPath` in local dev.
 *
 *   Indian addresses put the PIN last ("Indiranagar, Bengaluru 560038"), so unlike the FR/DE/ES/IT
 *   instances this locale needs no `LEADING_POSTCODE_COUNTRIES` entry — the existing trailing-
 *   postcode strip already folds the parent segment to a bare-city key.
 *
 *   THE FILE THIS BUILDS IS THE PACKAGE'S ENTIRE PAYLOAD. It is gitignored (derived), and a
 *   workspace that has never run this script packs to three metadata files describing an artifact
 *   that is not there — which is exactly how v8.6.0 shipped. `scripts/verify-tarball.ts` now
 *   refuses that publish, but the fix is to run this first.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = String(repoRootPath("neural-weights-en-in"))
const CLI = String(repoRootPath("mailwoman", "out", "cli.js"))
const PAIR_INDEX_BIN_DEST = resolve(PKG_DIR, "pair-index-in.bin")
/**
 * Checked-in WOF-derived (Ortsteil, Gemeinde) pairs — the same posture as the GB secondary sources.
 */
const WOF_ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
/**
 * Calibrated magnitudes — the pair the R10 bars were measured at (0/70 confound FPs, 59/60 tag-correct).
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
	console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for pair-index-in.bin.`)
} else if (!existsSync(WOF_ADMIN_DB)) {
	console.error(`WARNING: missing ${WOF_ADMIN_DB} — pair-index-in.bin not built.`)
} else {
	let needsRebuild = true

	if (existsSync(PAIR_INDEX_BIN_DEST)) {
		try {
			const header = peekPairIndexHeaderFields(PAIR_INDEX_BIN_DEST)

			if (header.delta !== PAIR_INDEX_DELTA) {
				console.log(`rebuilding pair-index-in.bin — delta ${header.delta} → ${PAIR_INDEX_DELTA}`)
			} else if (header.transitionBeta !== PAIR_INDEX_TRANSITION_BETA) {
				console.log(
					`rebuilding pair-index-in.bin — transitionBeta ${header.transitionBeta} → ${PAIR_INDEX_TRANSITION_BETA}`
				)
			} else {
				needsRebuild = false
			}
		} catch (error) {
			console.log(`rebuilding pair-index-in.bin — header unreadable (${(error as Error).message})`)
		}
	}

	if (!needsRebuild) {
		console.log(`skipped pair-index-in.bin build — ${PAIR_INDEX_BIN_DEST} is current`)
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
				"in",
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
			console.error(`FAILED: gazetteer pair-index --country in (exit ${result.status})`)

			process.exit(1)
		}

		console.log(`built pair-index-in.bin ← ${WOF_ADMIN_DB}`)
	}
}
