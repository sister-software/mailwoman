#!/usr/bin/env node
/**
 * Link dev artifacts into the base-latn workspace (FST-distribution arc precedent — same pattern as the locale weights
 * packages, but ships only the shared model + tokenizer + calibration + lexicons; locale-specific data stays in each
 * overlay).
 */
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath, weightsOverlayPath } from "@mailwoman/core/utils"
import { linkForce } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`).
 */
const DEST_DIR = String(weightsOverlayPath("base-latn"))

mkdirSync(DEST_DIR, { recursive: true })

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
const MODEL_DEST = resolve(DEST_DIR, "model.onnx")
/**
 * Where `tokenizer.model` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const TOKENIZER_DEST = resolve(DEST_DIR, "tokenizer.model")

linkForce(SRC_MODEL, MODEL_DEST)

console.log(`linked model.onnx ← ${SRC_MODEL}`)

linkForce(SRC_TOKENIZER, TOKENIZER_DEST)

console.log(`linked tokenizer.model ← ${SRC_TOKENIZER}`)

/**
 * Soft-feed lexicons: same sources as en-us (codex-generated repo files)
 */
const SRC_GAZETTEER = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
/**
 * Country-surface lexicon generated into the repo by the codex build.
 */
const SRC_COUNTRY = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")
/**
 * Model card carrying the digests and training provenance this script verifies against.
 */
const SRC_CARD = workspacePath("neural-weights-en-us", "model-card.json")
/**
 * Global confidence calibration emitted by the training run.
 */
const SRC_CALIBRATION = workspacePath("neural-weights-en-us", "calibration.json")
/**
 * Per-locale confidence calibration, applied on top of the global one.
 */
const SRC_CALIBRATION_PER_LOCALE = workspacePath("neural-weights-en-us", "calibration-per-locale.json")

for (const [src, name] of [
	[SRC_GAZETTEER, "anchor-lexicon-v1.json"],
	[SRC_COUNTRY, "country-surface-lexicon-v1.json"],
	[SRC_CARD, "model-card.json"],
	[SRC_CALIBRATION, "calibration.json"],
	[SRC_CALIBRATION_PER_LOCALE, "calibration-per-locale.json"],
] as const) {
	if (!existsSync(src)) {
		console.error(`MISSING ${src}`)

		continue
	}

	const dest = resolve(DEST_DIR, name)
	linkForce(src, dest)

	console.log(`linked ${name} ← ${src}`)
}
