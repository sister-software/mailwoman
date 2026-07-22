#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *   See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the rationale.
 *
 *   A single multilingual model serves both en-us and en-gb (byte-identical artifact;
 *   en-gb just carries its own postcode-anchor calibration). Re-symlinks the SAME files
 *   as en-us until per-locale training lands. Keep these defaults in lockstep with en-us's
 *   DEFAULT_* on every ship. The md5 guard reads en-us's model-card `files_md5` — one truth
 *   for the one artifact (en-gb's own card carries no files_md5 block).
 *
 *   ALSO links the soft-feed siblings a fresh worktree is otherwise missing (the
 *   fresh-worktree anchor-OFF gap: `link-dev-weights.ts` historically symlinked only
 *   model+tokenizer, leaving `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` /
 *   `postcode-gb.bin` absent — the CLI then parses anchor-OFF/gazetteer-OFF with only a
 *   stderr warning). The two lexicons are checked-in repo files (`data/gazetteer/…`), so
 *   they're symlinked straight from there. `postcode-gb.bin` has no committed source — it's
 *   a derived artifact built from the WOF GB postcode shard — so this script BUILDS it in
 *   place via the compiled `gazetteer postcode-binary` CLI (same command
 *   `scripts/copy-weights.ts` runs at publish time), mirroring how `postcode-fr.bin`
 *   already lives as a real (non-symlinked) file in `neural-weights-fr-fr/`.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-en-gb")
// In lockstep with en-us's DEFAULT_* (one multilingual artifact serves both) — keep this
// pair identical to neural-weights-en-us/scripts/link-dev-weights.ts's DEFAULT_MODEL /
// DEFAULT_TOKENIZER on every ship. The guard below fails loud on any future miss.
const SRC_MODEL =
	$public.MAILWOMAN_DEV_MODEL || dataRootPath("models", "quantized", "model-v385-latam-step-008000-int8.onnx")
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

if (!existsSync(SRC_MODEL)) {
	console.error(`missing source model: ${SRC_MODEL}`)
	process.exit(1)
}

if (!existsSync(SRC_TOKENIZER)) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)
	process.exit(1)
}

/** Replicate `ln -sf SRC DEST`: drop any pre-existing link/file at the destination, then symlink. */
function linkForce(src: string, dest: string): void {
	if (existsSync(dest)) {
		unlinkSync(dest)
	}

	symlinkSync(src, dest)
}

linkForce(SRC_MODEL, resolve(PKG_DIR, "model.onnx"))
linkForce(SRC_TOKENIZER, resolve(PKG_DIR, "tokenizer.model"))

console.log(`linked ${PKG_DIR}/{model.onnx,tokenizer.model}`)

// #397 guard, lockstep form: the en-gb artifact IS the en-us artifact, so verify the
// linked default bytes against en-us's model-card `files_md5` (skipped under an
// explicit MAILWOMAN_DEV_* override — deliberate experimentation).
if (!$public.MAILWOMAN_DEV_MODEL || !$public.MAILWOMAN_DEV_TOKENIZER) {
	const enUSCard = JSON.parse(
		readFileSync(resolve(PKG_DIR, "..", "neural-weights-en-us", "model-card.json"), "utf8")
	) as { files_md5?: Record<string, string> }
	const checks: Array<[string, string, string | undefined]> = [
		["model", resolve(PKG_DIR, "model.onnx"), enUSCard.files_md5?.["model.onnx"]],
		["tokenizer", resolve(PKG_DIR, "tokenizer.model"), enUSCard.files_md5?.["tokenizer.model"]],
	]

	for (const [label, path, expected] of checks) {
		if (
			($public.MAILWOMAN_DEV_MODEL && label === "model") ||
			($public.MAILWOMAN_DEV_TOKENIZER && label === "tokenizer")
		)
			continue

		if (!expected) {
			console.error(
				`ERROR (#397 guard): en-us model-card.json has no files_md5 entry for ${label} — cannot verify the dev pin.`
			)
			process.exit(1)
		}
		const actual = createHash("md5").update(readFileSync(path)).digest("hex")

		if (actual !== expected) {
			console.error(
				`ERROR (#397 guard): linked default ${label} md5 ${actual} != shipped ${expected} (en-us card files_md5).`
			)
			console.error("  Bump this script's SRC_* defaults in lockstep with en-us on each ship.")
			process.exit(1)
		}
	}
}

// --- soft-feed siblings (the fresh-worktree anchor-OFF gap) -----------------------------

// The gazetteer + country soft-feed lexicons are checked-in repo files — symlink straight
// from `data/gazetteer/` (the same source `release.config.json`'s `softFeed.gazetteerLexicon` /
// `softFeed.countryLexicon` name, and what `scripts/copy-weights.ts` copies verbatim at
// publish time).
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

// `postcode-gb.bin` has no committed source (it's derived from the WOF GB postcode shard),
// so build it in place with the compiled `gazetteer postcode-binary` CLI — the same command
// `scripts/copy-weights.ts` runs per-locale at publish time. Requires `yarn compile` to have
// run first (mailwoman/out/cli.js must exist); skips with a warning (not a hard failure) so a
// worktree without the GB WOF shard can still link the model/tokenizer/lexicons.
const GB_WOF_DB = dataRootPath("wof", "postalcode-gb.db")
const CLI = repoRootPath("mailwoman", "out", "cli.js")
const POSTCODE_BIN_DEST = resolve(PKG_DIR, "postcode-gb.bin")

if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-gb.bin.`
	)
} else if (!existsSync(GB_WOF_DB)) {
	console.error(
		`WARNING: missing ${GB_WOF_DB} — postcode-gb.bin not built; the anchor channel will resolve OFF for GB.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", PKG_DIR, "--locale", `GB:${GB_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(POSTCODE_BIN_DEST)) {
		console.error(`ERROR: failed to build ${POSTCODE_BIN_DEST} (exit ${result.status})`)
		process.exit(1)
	}
	console.log(`built ${POSTCODE_BIN_DEST}`)
}
