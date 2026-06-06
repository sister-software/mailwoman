#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Copy the trained neural model + tokenizer into each `neural-weights-<locale>` workspace so `npm
 *   publish` picks them up via the package's `files` glob. The workspace dirs hold only metadata in
 *   git (gitignored model.onnx + tokenizer.model); this script materializes the binaries at release
 *   time.
 *
 *   The source model + tokenizer paths come from `release.config.json` (`weights.dataRoot` +
 *   `weights.model` / `weights.tokenizer`) so the version-bearing filenames live in one place
 *   rather than hardcoded here. Override at release time via env vars:
 *
 *   - MAILWOMAN_DATA_ROOT: override `weights.dataRoot` (the machine's data dir)
 *   - MAILWOMAN_PUBLISH_MODEL: absolute path to the int8 quantized model.onnx (wins outright)
 *   - MAILWOMAN_PUBLISH_TOKENIZER: absolute path to the matching tokenizer.model (wins outright)
 *
 *   Idempotent. Used by .release-it.json's before:init hook.
 * @import {PathLike} from "node:fs"
 */

import { readFileSync } from "node:fs"
import { copyFile, mkdir, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const config = JSON.parse(readFileSync(resolve(repoRoot, "release.config.json"), "utf8"))
const dataRoot = process.env.MAILWOMAN_DATA_ROOT ?? config.weights.dataRoot
const SOURCE_MODEL = process.env.MAILWOMAN_PUBLISH_MODEL ?? resolve(dataRoot, config.weights.model)
const SOURCE_TOKENIZER = process.env.MAILWOMAN_PUBLISH_TOKENIZER ?? resolve(dataRoot, config.weights.tokenizer)

const TARGETS = config.locales.map((locale) => `neural-weights-${locale}`)

/**
 * @param {PathLike} path
 */
async function exists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function main() {
	// CI release workflow sets MAILWOMAN_SKIP_WEIGHTS_COPY=1 when release_weights
	// input is false (the default). Weights binaries live at /mnt/playpen on the
	// operator's host and aren't fetchable from CI; the workflow excludes the
	// weights workspaces from the publish set in that mode, so skipping the
	// copy is correct.
	if (process.env.MAILWOMAN_SKIP_WEIGHTS_COPY) {
		process.stderr.write("copy-weights: MAILWOMAN_SKIP_WEIGHTS_COPY set — skipping.\n")
		return
	}

	if (!(await exists(SOURCE_MODEL))) {
		throw new Error(`Missing source model: ${SOURCE_MODEL}\nSet MAILWOMAN_PUBLISH_MODEL to override.`)
	}
	if (!(await exists(SOURCE_TOKENIZER))) {
		throw new Error(`Missing source tokenizer: ${SOURCE_TOKENIZER}\nSet MAILWOMAN_PUBLISH_TOKENIZER to override.`)
	}

	for (const workspace of TARGETS) {
		const dir = resolve(repoRoot, workspace)
		await mkdir(dir, { recursive: true })
		const modelDest = resolve(dir, "model.onnx")
		const tokenizerDest = resolve(dir, "tokenizer.model")
		// Unlink first so a pre-existing symlink (from link-dev-weights.sh) is
		// replaced with a real file. Otherwise copyFile follows the symlink and
		// writes through it, leaving the symlink in place — which yarn refuses
		// to publish (npm registry rejects symlinks with HTTP 415).
		await removeIfPresent(modelDest)
		await removeIfPresent(tokenizerDest)
		await copyFile(SOURCE_MODEL, modelDest)
		await copyFile(SOURCE_TOKENIZER, tokenizerDest)
		process.stderr.write(`copied weights → ${workspace}/{model.onnx,tokenizer.model}\n`)
	}
}

/**
 * @param {PathLike} path
 */
async function removeIfPresent(path) {
	try {
		await unlink(path)
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err
	}
}

main().catch((err) => {
	process.stderr.write(`copy-weights failed: ${err.message}\n`)
	process.exit(1)
})
