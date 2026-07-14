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
 *   linked bytes match the package's own `model-card.json` `files_md5` — the md5s the
 *   release pipeline re-verifies the PUBLISHED tarball against. A mismatch FAILS LOUD
 *   instead of grading the wrong model.
 *
 *   ON SHIP: bump the two DEFAULT_* paths below to the new artifacts. The md5s are NOT
 *   duplicated here — they come from model-card.json, which the release-prep PR updates
 *   anyway. A path bumped without the card (or vice versa) fails the guard immediately;
 *   the 2026-07-02 v5.1.0 ship missed the path bump here and the duplicated-md5 design
 *   couldn't catch it (the stale pin was self-consistent — #259's trap, post-release form).
 *   ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

// --- current default (npm v5.9.0 = demo defaultVersion v5.9.0) --------------
// 6.1.0 ships v261-span-boundary-full (step-8000) int8 model + the v0.9.0-multisplice tokenizer — another coordinated model + tokenizer bump, so BOTH
// paths moved this ship. Bump these two paths on each ship; the expected md5s live in
// model-card.json `files_md5` (single source — see the header).
const DEFAULT_MODEL = dataRootPath("models", "quantized", "model-v261-span-boundary-full-step-008000-int8.onnx")
const DEFAULT_TOKENIZER = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

const PKG_DIR = repoRootPath("neural-weights-en-us")

// The shipped-bytes truth (#397 guard): the card's files_md5 block, which release Step 4
// re-verifies against the published tarball — so dev symlinks, the card, and npm agree.
const CARD = JSON.parse(readFileSync(resolve(PKG_DIR, "model-card.json"), "utf8")) as {
	files_md5?: Record<string, string>
}
const DEFAULT_MODEL_MD5 = CARD.files_md5?.["model.onnx"]
const DEFAULT_TOKENIZER_MD5 = CARD.files_md5?.["tokenizer.model"]

if (!DEFAULT_MODEL_MD5 || !DEFAULT_TOKENIZER_MD5) {
	console.error(
		"ERROR (#397 guard): model-card.json has no files_md5.{model.onnx,tokenizer.model} — cannot verify the dev pin."
	)
	process.exit(1)
}

// An explicit override means the caller is deliberately experimenting with a
// non-default model — skip the hash assertion in that case (but warn loudly).
const MODEL_OVERRIDDEN = !!$public.MAILWOMAN_DEV_MODEL
const TOKENIZER_OVERRIDDEN = !!$public.MAILWOMAN_DEV_TOKENIZER

const SRC_MODEL = $public.MAILWOMAN_DEV_MODEL || DEFAULT_MODEL
const SRC_TOKENIZER = $public.MAILWOMAN_DEV_TOKENIZER || DEFAULT_TOKENIZER

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
	if (existsSync(dest)) {
		unlinkSync(dest)
	}

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
