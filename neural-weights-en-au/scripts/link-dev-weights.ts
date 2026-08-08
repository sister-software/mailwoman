#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-au overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (same shape as en-nz/en-gb/fr-fr): en-au declares
 *   `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through
 *   to the en-us package for `model.onnx` / `tokenizer.model`. This script therefore links no
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages
 *   (a stale local file would SHADOW the base fallback and silently serve outdated bytes; see the
 *   fr-fr script's header for the incident that taught this).
 *
 *   What en-au owns locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `country-surface-lexicon-v1.json` — checked-in repo file, symlinked from `data/gazetteer/`.
 *     The country channel loads this to constrain the resolver.
 *
 *   en-au is INITIAL (2026-08-08): NO postcode-au.bin (no WOF AU postcode shard exists), NO
 *   pair-index-au.bin (PIX1 not yet calibrated for AU), NO anchor-lexicon (anchor channel OFF).
 *   The overlay exists so `--locale en-AU` resolves and the resolver's country scope constrains
 *   the candidate lookup — that alone fixes the WA→Washington-State homonym class diagnosed in the
 *   2026-08-07 FIRST-PASS benchmark.
 *
 *   FRESHNESS GUARD: none needed yet — no derived artifacts are built. The lexicons are
 *   checked-in repo files symlinked in place; there's nothing to go stale.
 */

import { existsSync, lstatSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * Workspace root the artifacts are linked into. Everything below resolves against it.
 */
const PKG_DIR = repoRootPath("neural-weights-en-au")

/**
 * Replicate `ln -sf SRC DEST` ATOMICALLY: symlink under a temp name, then rename over the destination. A plain
 * unlink-then-symlink leaves a no-file window that concurrent vitest workers can hit mid-suite — bit CI on 2026-07-24.
 * rename(2) replaces the destination atomically.
 */
function linkForce(src: string, dest: string): void {
	const tmp = `${dest}.tmp-link`

	if (existsSync(tmp)) {
		unlinkSync(tmp)
	}

	symlinkSync(src, tmp)
	renameSync(tmp, dest)
}

/**
 * Remove a leftover local file/symlink so the #1179 base-weights fallback engages.
 */
function removeIfPresent(dest: string): void {
	try {
		lstatSync(dest)
	} catch {
		return
	}

	unlinkSync(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

removeIfPresent(resolve(PKG_DIR, "model.onnx"))
removeIfPresent(resolve(PKG_DIR, "tokenizer.model"))

/**
 * --- soft-feed siblings (locale-owned; the fresh-worktree country-OFF gap) -----.
 */

const SRC_COUNTRY_LEXICON = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

if (existsSync(SRC_COUNTRY_LEXICON)) {
	linkForce(SRC_COUNTRY_LEXICON, resolve(PKG_DIR, "country-surface-lexicon-v1.json"))

	console.log(`linked ${PKG_DIR}/country-surface-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_COUNTRY_LEXICON} — country channel will resolve OFF in this worktree.`)
}

/**
 * Street-morphology FST (static-index candidate 1, 2026-07-26): symlink the sealed locale-general artifact
 * ($MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin, `mailwoman gazetteer build street-morphology`) so
 * `resolveWeights` surfaces `streetMorphologyPath` in dev and the street-context gate (#1315) deserializes the artifact
 * instead of rebuilding from dictionaries. Missing is non-fatal — the runtime loader's dictionary-build fallback covers
 * it.
 */

const MORPHOLOGY_SRC = dataRootPath("wof", "fst-street-morphology.bin")
const MORPHOLOGY_DEST = resolve(PKG_DIR, "fst-street-morphology.bin")

if (existsSync(MORPHOLOGY_SRC)) {
	linkForce(MORPHOLOGY_SRC, MORPHOLOGY_DEST)

	console.log(`linked fst-street-morphology.bin ← ${MORPHOLOGY_SRC}`)
} else {
	console.error(
		`WARNING: missing ${MORPHOLOGY_SRC} — the street-context gate falls back to the per-process dictionary build.`
	)
}
