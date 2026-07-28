#!/usr/bin/env node
/**
 * Link dev artifacts into the base-latn workspace (FST-distribution arc precedent — same pattern as the locale weights
 * packages, but ships only the shared model + tokenizer + calibration + lexicons; locale-specific data stays in each
 * overlay).
 */
import { existsSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-base-latn")

function linkForce(src: string, dest: string): void {
	const tmp = `${dest}.tmp-link`

	if (existsSync(tmp)) {
		unlinkSync(tmp)
	}
	symlinkSync(src, tmp)
	renameSync(tmp, dest)
}

/** Model + tokenizer: same source as the en-us workspace uses ($MAILWOMAN_DEV_MODEL env override supported). */
const SRC_MODEL =
	$public.MAILWOMAN_DEV_MODEL || dataRootPath("models", "quantized", "model-v385-latam-step-008000-int8.onnx")
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
const MODEL_DEST = resolve(PKG_DIR, "model.onnx")
const TOKENIZER_DEST = resolve(PKG_DIR, "tokenizer.model")

linkForce(SRC_MODEL, MODEL_DEST)
console.log(`linked model.onnx ← ${SRC_MODEL}`)
linkForce(SRC_TOKENIZER, TOKENIZER_DEST)
console.log(`linked tokenizer.model ← ${SRC_TOKENIZER}`)

/** Soft-feed lexicons: same sources as en-us (codex-generated repo files) */
const SRC_GAZETTEER = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
const SRC_COUNTRY = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")
const SRC_CARD = repoRootPath("neural-weights-en-us", "model-card.json")
const SRC_CALIBRATION = repoRootPath("neural-weights-en-us", "calibration.json")
const SRC_CALIBRATION_PER_LOCALE = repoRootPath("neural-weights-en-us", "calibration-per-locale.json")

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
	const dest = resolve(PKG_DIR, name)
	linkForce(src, dest)
	console.log(`linked ${name} ← ${src}`)
}
