#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *
 *   The published @mailwoman/neural-weights-en-us bundle contains the real model.onnx
 *   + tokenizer.model files (declared in package.json `files`). In the monorepo only
 *   the metadata files (package.json, model-card.json, README.md) are committed; the
 *   binaries live in `$MAILWOMAN_DATA_ROOT/models/` from training and get copied
 *   in at publish time.
 *
 *   This script symlinks the dev artifacts so `@mailwoman/neural`'s loadFromWeights
 *   can find them during local testing. Run from anywhere; resolves paths from the
 *   package dir.
 *
 *   ---------------------------------------------------------------------------
 *   #397 GUARD — why this script verifies a hash (read before editing the paths)
 *   ---------------------------------------------------------------------------
 *   `neural/test/weights.test.ts` invokes this script, so EVERY `yarn test` run
 *   re-creates these symlinks. If the defaults below point at a stale model, the
 *   whole repo silently starts grading evals against the wrong weights — which is
 *   exactly the trap that wasted an eval shift (the symlink had drifted to
 *   v0.5.3 / tokenizer v0.5.0-a1 while the deployed default was v4.0.0).
 *
 *   To make drift impossible to ignore, when the DEFAULT artifacts are used (no
 *   MAILWOMAN_DEV_MODEL / MAILWOMAN_DEV_TOKENIZER override) this script asserts the
 *   linked bytes match EXPECTED_*_MD5 — the md5 of what the demo actually serves at
 *     https://public.sister.software/mailwoman/en-us/<defaultVersion>/{model,tokenizer}
 *   A mismatch FAILS LOUD instead of grading the wrong model.
 *
 *   ON DEFAULT PROMOTION (releases.json `defaultVersion` bump): update the four
 *   DEFAULT_* values below to the new artifact + its md5 in ONE place. Recompute via:
 *     curl -s https://public.sister.software/mailwoman/en-us/<ver>/model.onnx | md5sum
 *     curl -s https://public.sister.software/mailwoman/en-us/<ver>/tokenizer.model | md5sum
 *   ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { dataRootPath } from "@mailwoman/core/utils"

// --- current default (releases.json defaultVersion = v4.4.0) ---------------
// v4.3.0 en-us ships the v1.1.0-relabel-consolidation model (step 40000, from
// scratch on the label-consistent mix — #511 affix relabel; affix 93.6/96.6) with
// the locale head exported (locale_logits) for the conventions mask (#478 slice 1),
// + the 0.6.0-a0 tokenizer. These md5s are the authoritative bytes the demo serves
// at .../mailwoman/en-us/v4.11.0/{model,tokenizer} — the v1.8.0-fr-admin-split model the
// current model-card certifies, so the capability-gate's maskOff F1 matches the card.
const DEFAULT_MODEL = dataRootPath("models", "quantized", "model-v180-step-40000-int8.onnx")
const DEFAULT_MODEL_MD5 = "d163396ce30869e117bf29ffb939177b"
const DEFAULT_TOKENIZER = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const DEFAULT_TOKENIZER_MD5 = "b6137e8c52914c9715374268ecaa4bc6"

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// An explicit override means the caller is deliberately experimenting with a
// non-default model — skip the hash assertion in that case (but warn loudly).
const MODEL_OVERRIDDEN = !!process.env.MAILWOMAN_DEV_MODEL
const TOKENIZER_OVERRIDDEN = !!process.env.MAILWOMAN_DEV_TOKENIZER

const SRC_MODEL = process.env.MAILWOMAN_DEV_MODEL || DEFAULT_MODEL
const SRC_TOKENIZER = process.env.MAILWOMAN_DEV_TOKENIZER || DEFAULT_TOKENIZER

if (!existsSync(SRC_MODEL)) {
	console.error(`missing source model: ${SRC_MODEL}`)
	console.error("set MAILWOMAN_DEV_MODEL to override")
	process.exit(1)
}

if (!existsSync(SRC_TOKENIZER)) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)
	console.error("set MAILWOMAN_DEV_TOKENIZER to override")
	process.exit(1)
}

/** Replicate `ln -sf SRC DEST`: drop any pre-existing link/file at the destination, then symlink. */
function linkForce(src: string, dest: string): void {
	if (existsSync(dest)) unlinkSync(dest)

	symlinkSync(src, dest)
}

const MODEL_DEST = resolve(PKG_DIR, "model.onnx")
const TOKENIZER_DEST = resolve(PKG_DIR, "tokenizer.model")

linkForce(SRC_MODEL, MODEL_DEST)
linkForce(SRC_TOKENIZER, TOKENIZER_DEST)

console.log("linked:")
console.log(`  ${MODEL_DEST} → ${SRC_MODEL}`)
console.log(`  ${TOKENIZER_DEST} → ${SRC_TOKENIZER}`)

// --- #397 drift guard: assert default bytes match what the demo serves ------
function assertMd5(label: string, path: string, expected: string): void {
	const actual = createHash("md5").update(readFileSync(path)).digest("hex")

	if (actual !== expected) {
		console.error("")
		console.error(`ERROR (#397 guard): linked default ${label} md5 mismatch.`)
		console.error(`  linked:   ${path}`)
		console.error(`  got:      ${actual}`)
		console.error(`  expected: ${expected} (deployed en-us defaultVersion)`)
		console.error("  The dev symlink has drifted from the deployed default. Either the")
		console.error("  artifact moved, or releases.json defaultVersion changed without a")
		console.error(`  matching bump to DEFAULT_${label.toUpperCase()}_MD5 in this script.`)
		process.exit(1)
	}
}

if (!MODEL_OVERRIDDEN) {
	assertMd5("model", MODEL_DEST, DEFAULT_MODEL_MD5)
} else {
	console.error("  (model override active — skipping #397 default-hash check)")
}

if (!TOKENIZER_OVERRIDDEN) {
	assertMd5("tokenizer", TOKENIZER_DEST, DEFAULT_TOKENIZER_MD5)
} else {
	console.error("  (tokenizer override active — skipping #397 default-hash check)")
}
