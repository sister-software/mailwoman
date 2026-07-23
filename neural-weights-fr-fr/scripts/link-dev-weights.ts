#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the fr-fr overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (2026-07-23 rewrite): fr-fr declares `mailwoman.baseWeights:
 *   "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through to the en-us package
 *   for `model.onnx` / `tokenizer.model` / the card. This script therefore no longer links a
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages.
 *   (The previous version re-symlinked a pinned v241-fr-nsplice model on every `yarn test`;
 *   since #1179 that local file SHADOWED the base fallback, silently running the stale model for
 *   every dev fr-fr parse, and its #397 md5 guard could never pass against the en-us card. One
 *   model, one pin — en-us's script owns it.)
 *
 *   What fr-fr DOES own locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files,
 *       symlinked from `data/gazetteer/`.
 *   - `postcode-fr.bin` — derived from the WOF intl postcode shard
 *       (`softFeed.postcodeDBByCountry.fr` = postalcode-intl.db), built in place via the compiled
 *       `gazetteer postcode-binary` CLI (skip-if-exists; rebuilds in seconds). Without it a fresh
 *       worktree parses anchor-OFF — see the en-us script's section comment for the CI failure
 *       this caused.
 */

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-fr-fr")

/** Replicate `ln -sf SRC DEST`: drop any pre-existing link/file at the destination, then symlink. */
function linkForce(src: string, dest: string): void {
	if (existsSync(dest)) {
		unlinkSync(dest)
	}

	symlinkSync(src, dest)
}

/** Remove a leftover local file/symlink so the #1179 base-weights fallback engages. */
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

// --- soft-feed siblings (locale-owned; the fresh-worktree anchor-OFF gap) ----------------
const SRC_GAZETTEER_LEXICON = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
const SRC_COUNTRY_LEXICON = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

if (existsSync(SRC_GAZETTEER_LEXICON)) {
	linkForce(SRC_GAZETTEER_LEXICON, resolve(PKG_DIR, "anchor-lexicon-v1.json"))
	console.log(`linked ${PKG_DIR}/anchor-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_GAZETTEER_LEXICON} — gazetteer channel will resolve OFF in this worktree.`)
}

if (existsSync(SRC_COUNTRY_LEXICON)) {
	linkForce(SRC_COUNTRY_LEXICON, resolve(PKG_DIR, "country-surface-lexicon-v1.json"))
	console.log(`linked ${PKG_DIR}/country-surface-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_COUNTRY_LEXICON} — country channel will resolve OFF in this worktree.`)
}

const FR_WOF_DB = dataRootPath("wof", "postalcode-intl.db")
const CLI = repoRootPath("mailwoman", "out", "cli.js")
const POSTCODE_BIN_DEST = resolve(PKG_DIR, "postcode-fr.bin")

if (existsSync(POSTCODE_BIN_DEST)) {
	console.log(`skipped postcode-fr.bin build — ${POSTCODE_BIN_DEST} already present`)
} else if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-fr.bin.`
	)
} else if (!existsSync(FR_WOF_DB)) {
	console.error(
		`WARNING: missing ${FR_WOF_DB} — postcode-fr.bin not built; the anchor channel will resolve OFF for FR.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", PKG_DIR, "--locale", `FR:${FR_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(POSTCODE_BIN_DEST)) {
		console.error(`ERROR: failed to build ${POSTCODE_BIN_DEST} (exit ${result.status})`)
		process.exit(1)
	}
	console.log(`built ${POSTCODE_BIN_DEST}`)
}
