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
 *   on every defaultVersion bump (currently v4.1.0 = v0.9.7-unit-v3, tokenizer 0.6.0-a0).
 */

import { existsSync, symlinkSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { dataRootPath } from "@mailwoman/core/utils"

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// In lockstep with en-us's DEFAULT_MODEL (one multilingual artifact serves both). 2026-06-28: this had
// drifted to the stale v097 step-20000 bytes; bumped to the v4.15.0 / v1.9.3a3 shipped model.
const SRC_MODEL =
	process.env.MAILWOMAN_DEV_MODEL || dataRootPath("models", "quantized", "model-v193a3-step-80000-int8.onnx")
const SRC_TOKENIZER =
	process.env.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")

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
	if (existsSync(dest)) unlinkSync(dest)

	symlinkSync(src, dest)
}

linkForce(SRC_MODEL, resolve(PKG_DIR, "model.onnx"))
linkForce(SRC_TOKENIZER, resolve(PKG_DIR, "tokenizer.model"))

console.log(`linked ${PKG_DIR}/{model.onnx,tokenizer.model}`)
