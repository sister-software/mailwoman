/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A SentencePiece model's vocabulary, read and edited through `mtf-tokenizer`, and an encoder over it through the
 *   `@mailwoman/mtf` runtime.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { replaceFileAtomically, writeLocalJSONFile } from "@mailwoman/core/fs/writers"

import { MTF_WASM_URL, type MTFModel, MTFRuntime } from "#index"

import { runMTFTokenizer } from "./binary.ts"

/**
 * `ModelProto.SentencePiece.Type`, by wire value.
 */
export const PieceType = {
	Normal: 1,
	Unknown: 2,
	Control: 3,
	UserDefined: 4,
	Unused: 5,
	Byte: 6,
} as const

export type PieceType = (typeof PieceType)[keyof typeof PieceType]

/**
 * One vocabulary entry.
 * `score` is the stored `float32`, widened exactly.
 */
export type VocabularyPiece = readonly [piece: string, score: number, type: PieceType]

/**
 * Every piece of the model at `path`, in id order.
 */
export async function readModelPieces(path: string): Promise<VocabularyPiece[]> {
	await using scratch = await temporaryDirectory("mtf-inspect-")
	const out = scratch.path("pieces.json").toString()

	await runMTFTokenizer<object>(["inspect", path, "--out", out])
	const { pieces } = await readLocalJSONFile<{ pieces: VocabularyPiece[] }>(out)

	return pieces
}

/**
 * The edits `mtf-tokenizer edit` applies, in this order.
 */
export interface ModelEdit {
	/**
	 * The piece ids to keep, in the order to keep them.
	 */
	keep?: readonly number[]
	/**
	 * Pieces to append after the kept ones.
	 */
	append?: readonly VocabularyPiece[]
	/**
	 * The flag names of the training call that wrote the model.
	 *
	 * The trainer and normalizer spec fields no flag named are dropped, which turns a
	 * native `spm_train` model into the bytes the Python wheel writes.
	 */
	wheelFlags?: readonly string[]
}

/**
 * What an edit dropped from each spec, by field number.
 */
export interface ModelEditSummary {
	pieces: number
	dropped_fields: { trainer?: number[]; normalizer?: number[] }
}

/**
 * Write `source` with `edit` applied to `destination`, which may be `source` itself.
 */
export async function editModel(source: string, destination: string, edit: ModelEdit): Promise<ModelEditSummary> {
	await using scratch = await temporaryDirectory("mtf-edit-")
	const plan = scratch.path("plan.json").toString()
	const staged = scratch.path("model").toString()

	await writeLocalJSONFile(
		{ keep: edit.keep ?? null, append: edit.append ?? null, wheel_flags: edit.wheelFlags ?? null },
		plan
	)

	const summary = await runMTFTokenizer<ModelEditSummary>(["edit", source, "--plan", plan, "--out", staged])

	await replaceFileAtomically(staged, destination)

	return summary
}

let runtime: Promise<MTFRuntime> | null = null

/**
 * The model at `path`, loaded into the WebAssembly runtime.
 * Dispose it after use.
 */
export async function loadEncoder(path: string): Promise<MTFModel> {
	runtime ??= readLocalBuffer(MTF_WASM_URL).then((bytes) => MTFRuntime.instantiate(new Uint8Array(bytes)))

	return (await runtime).loadModel(await readLocalBuffer(path))
}
