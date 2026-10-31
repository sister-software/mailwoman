/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prune a tokenizer's unused pieces and the matching rows of an int8 model's embedding table.
 *
 *   A piece that never won a Viterbi path contributes no score to any other path, so segmentation is unchanged for
 *   every input whose best path avoided the pruned pieces. The kept pieces stay in their order. The embedding rows
 *   are gathered by the old-to-new id map with the scale and zero point untouched, so each kept row stays the same
 *   bytes.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { readFileSize } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalBuffer, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"

import { runMTFTokenizer } from "./binary.ts"
import { editModel, PieceType, readModelPieces } from "./model.ts"

/**
 * The quantized embedding table of the BIO token classifier.
 */
export const QUANTIZED_EMBEDDING = "inner.token_embeddings.weight_quantized"

/**
 * The id map `prunePieces` writes as `id-map.json`: the kept old ids in order,
 * and each old id's new id or -1.
 */
export interface PruneIDMap {
	kept_ids: number[]
	old_to_new: number[]
}

export interface PruneReport {
	vocab_before: number
	vocab_after: number
	train_fired: number
	eval_fired: number
	single_codepoint_kept: number
	tokenizer_bytes: { before: number; after: number }
	onnx_bytes: { before: number; after: number }
}

export interface PruneOptions {
	tokenizer: string
	onnx: string
	/**
	 * A JSON file whose `counts` is each piece's use count over the training corpus,
	 * as `utilization.run.ts` writes.
	 */
	trainCounts: string
	/**
	 * A JSON file whose `fired_ids` lists the pieces the evaluation surface uses.
	 */
	evalFired: string
	outDirectory: string
}

/**
 * The pieces to keep: every piece the training corpus or the evaluation surface used, every
 * piece that is not a normal piece (control, unknown, user-defined, unused and byte pieces),
 * and every piece of at most one code point once a leading `▁` is removed.
 * This keeps every character reachable.
 */
export function keepSet(
	vocabulary: readonly (readonly [string, number, number])[],
	counts: readonly number[],
	evalFired: readonly number[]
): { keep: boolean[]; singleCodepoint: number } {
	if (counts.length !== vocabulary.length) {
		throw new Error(`the counts cover ${counts.length} pieces and the tokenizer has ${vocabulary.length}`)
	}

	const keep = counts.map((n) => n > 0)

	for (const id of evalFired) {
		if (id < 0 || id >= keep.length) throw new Error(`eval-fired id ${id} is outside the vocabulary`)
		keep[id] = true
	}

	let singleCodepoint = 0

	vocabulary.forEach(([piece, , type], id) => {
		if (type !== PieceType.Normal) {
			keep[id] = true

			return
		}

		const literal = piece.startsWith("▁") ? piece.slice(1) : piece

		if ([...literal].length <= 1) {
			keep[id] = true

			singleCodepoint++
		}
	})

	return { keep, singleCodepoint }
}

/**
 * Write the pruned `tokenizer.model`, `model.onnx`, `id-map.json`
 * and `prune-report.json` under the output directory.
 */
export async function prunePieces(options: PruneOptions): Promise<PruneReport> {
	const vocabulary = await readModelPieces(options.tokenizer)
	const { counts } = await readLocalJSONFile<{ counts: number[] }>(options.trainCounts)
	const { fired_ids: evalFired } = await readLocalJSONFile<{ fired_ids: number[] }>(options.evalFired)
	const { keep, singleCodepoint } = keepSet(vocabulary, counts, evalFired)
	const keptIDs = keep.flatMap((kept, id) => (kept ? [id] : []))
	const oldToNew = new Array<number>(vocabulary.length).fill(-1)

	keptIDs.forEach((id, i) => {
		oldToNew[id] = i
	})

	const trainFired = counts.filter((n) => n > 0).length
	const evalCount = new Set(evalFired).size

	console.info(
		`[prune] vocab ${vocabulary.length} → keep ${keptIDs.length} (${((100 * keptIDs.length) / vocabulary.length).toFixed(1)}%)`
	)
	console.info(`[prune]   train-fired ${trainFired}, eval-fired ${evalCount}, single-codepoint kept ${singleCodepoint}`)

	await makeDirectories(options.outDirectory)
	const tokenizerOut = `${options.outDirectory}/tokenizer.model`

	await editModel(options.tokenizer, tokenizerOut, { keep: keptIDs })

	await using scratch = await temporaryDirectory("mtf-prune-")
	const table = scratch.path("table.bin").toString()
	const gathered = scratch.path("gathered.bin").toString()
	const onnxOut = `${options.outDirectory}/model.onnx`

	const meta = await runMTFTokenizer<{ dims: number[]; data_type: number }>([
		"onnx-read",
		"--model",
		options.onnx,
		"--name",
		QUANTIZED_EMBEDDING,
		"--raw-out",
		table,
	])

	if (meta.dims[0] !== vocabulary.length) {
		throw new Error(`embedding rows ${meta.dims[0]} != vocab ${vocabulary.length}`)
	}

	const rowBytes = (await readFileSize(table)) / vocabulary.length
	const rows = await readLocalBuffer(table)
	const out = Buffer.alloc(keptIDs.length * rowBytes)

	keptIDs.forEach((id, i) => rows.copy(out, i * rowBytes, id * rowBytes, (id + 1) * rowBytes))
	await writeLocalBuffer(out, gathered)

	await runMTFTokenizer([
		"onnx-write",
		"--model",
		options.onnx,
		"--name",
		QUANTIZED_EMBEDDING,
		"--dims",
		[keptIDs.length, ...meta.dims.slice(1)].join(","),
		"--data-type",
		String(meta.data_type),
		"--raw",
		gathered,
		"--out",
		onnxOut,
	])

	const idMap: PruneIDMap = { kept_ids: keptIDs, old_to_new: oldToNew }

	await writeLocalJSONFile(idMap, `${options.outDirectory}/id-map.json`)

	const report: PruneReport = {
		vocab_before: vocabulary.length,
		vocab_after: keptIDs.length,
		train_fired: trainFired,
		eval_fired: evalCount,
		single_codepoint_kept: singleCodepoint,
		tokenizer_bytes: { before: await readFileSize(options.tokenizer), after: await readFileSize(tokenizerOut) },
		onnx_bytes: { before: await readFileSize(options.onnx), after: await readFileSize(onnxOut) },
	}

	await writeLocalTextFile(prettyJSON(report, true, 1), `${options.outDirectory}/prune-report.json`)

	console.info(prettyJSON(report, false, 1))

	return report
}
