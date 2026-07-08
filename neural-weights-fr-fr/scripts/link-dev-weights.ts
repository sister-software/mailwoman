#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *   See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the rationale.
 *
 *   A single multilingual model serves both en-us and fr-fr (byte-identical artifact;
 *   fr-fr just carries its own calibration). Re-symlinks the SAME files as en-us until
 *   per-locale training lands. Keep these defaults in lockstep with en-us's DEFAULT_*
 *   on every ship (currently v5.1.0 = bsplice-meaninit + the spliced v0.6.0-bsplice
 *   tokenizer). The md5 guard reads en-us's model-card `files_md5` — one truth for the
 *   one artifact (fr-fr's own card carries no files_md5 block).
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-fr-fr")
// In lockstep with en-us's DEFAULT_* (one multilingual artifact serves both) — v5.1.0
// bsplice pair (#884). The 2026-07-02 ship missed this bump (both linkers still pinned
// the demo-only v4.16.0 pair); the guard below now fails loud on any future miss.
const SRC_MODEL = $public.MAILWOMAN_DEV_MODEL || dataRootPath("models", "quantized", "model-bsplice-meaninit-int8.onnx")
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.6.0-bsplice", "tokenizer.model")

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

// #397 guard, lockstep form: the fr-fr artifact IS the en-us artifact, so verify the
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
