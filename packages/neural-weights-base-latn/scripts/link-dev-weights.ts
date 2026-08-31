#!/usr/bin/env node
import { $public } from "@mailwoman/core/env"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { dataRootPath, repoRootPath, weightsOverlayPath, workspacePath } from "@mailwoman/core/utils"
/**
 * Link dev artifacts into the base-latn workspace (FST-distribution arc precedent — same pattern as the locale weights
 * packages, but ships only the shared model + tokenizer + calibration + lexicons; locale-specific data stays in each
 * overlay).
 */
import { linkForce, linkSoftFeedSibling } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`).
 */
const DEST_DIR = String(weightsOverlayPath("base-latn"))

await makeDirectories(DEST_DIR)

/**
 * Model + tokenizer: same source as the en-us workspace uses ($MAILWOMAN_DEV_MODEL env override supported).
 */
const SRC_MODEL =
	$public.MAILWOMAN_DEV_MODEL ||
	dataRootPath("models", "quantized", "model-v440-suffix-boundary-v2-step-060000-int8.onnx")

/**
 * Tokenizer actually linked — the environment override if set, otherwise the card's default.
 */
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

/**
 * Where `model.onnx` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const MODEL_DEST = resolvePath(DEST_DIR, "model.onnx")
/**
 * Where `tokenizer.model` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const TOKENIZER_DEST = resolvePath(DEST_DIR, "tokenizer.model")

await linkForce(SRC_MODEL, MODEL_DEST)

console.log(`linked model.onnx ← ${SRC_MODEL}`)

await linkForce(SRC_TOKENIZER, TOKENIZER_DEST)

console.log(`linked tokenizer.model ← ${SRC_TOKENIZER}`)

/**
 * Soft-feed lexicons + shared metadata: same sources as en-us (codex-generated repo files, en-us's committed card and
 * calibration pair). Each link takes the shared warn-and-continue miss semantics — the consequence line says which
 * channel or metadata just resolved OFF for this overlay.
 */
for (const [src, name, consequenceIfMissing] of [
	[
		repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json"),
		"anchor-lexicon-v1.json",
		"gazetteer channel will resolve OFF in this worktree.",
	],
	[
		repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json"),
		"country-surface-lexicon-v1.json",
		"country channel will resolve OFF in this worktree.",
	],
	[
		String(workspacePath("neural-weights-en-us", "model-card.json")),
		"model-card.json",
		"the base-latn overlay carries no model card (labels fall back to the compile-time default).",
	],
	[
		String(workspacePath("neural-weights-en-us", "calibration.json")),
		"calibration.json",
		"confidence calibration will resolve OFF for this overlay.",
	],
	[
		String(workspacePath("neural-weights-en-us", "calibration-per-locale.json")),
		"calibration-per-locale.json",
		"per-locale confidence calibration will resolve OFF for this overlay.",
	],
] as const) {
	await linkSoftFeedSibling(src, resolvePath(DEST_DIR, name), consequenceIfMissing)
}
