/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two checks a pruned tokenizer and model pass before release.
 *
 *   B1, segmentation identity: the original and pruned tokenizers produce the same piece sequence, modulo the id
 *   renumbering, on every evaluation text and on a random sample of the training rows.
 *
 *   B2, logit identity: the original and pruned int8 models answer the evaluation inputs with the same output bits.
 *   The graphs differ only in the embedding table and the kept rows are the same bytes, so any difference is a defect
 *   of the surgery. Every channel input is fed zeros, because the identity must hold for any channel values. The
 *   release battery covers realistic inputs.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"

import { runMTFTokenizer } from "./binary.ts"
import { loadEncoder } from "./model.ts"
import type { PruneIDMap } from "./prune.ts"

/**
 * The number of differing texts each check prints in full.
 * The rest are only counted.
 */
const SEGMENTATION_DIFFERENCES_SHOWN = 5
const LOGIT_DIFFERENCES_SHOWN = 3

/**
 * An encoder's `encode`, as the checks call it.
 */
export interface PieceEncoder {
	encode(text: string): { ids: number[]; pieces: string[] }
}

/**
 * B1: the number of `texts` the two tokenizers segment differently, modulo the renumbering.
 *
 * An id that maps to -1 counts as a difference on its own: the pruned vocabulary
 * dropped a piece the text needs.
 */
export function checkSegmentationIdentity(
	original: PieceEncoder,
	pruned: PieceEncoder,
	oldToNew: readonly number[],
	texts: readonly string[],
	label: string
): number {
	let differing = 0

	for (const text of texts) {
		const before = original.encode(text)
		const after = pruned.encode(text)
		const mapped = before.ids.map((id) => oldToNew[id] ?? -1)

		if (mapped.includes(-1) || mapped.length !== after.ids.length || mapped.some((id, i) => id !== after.ids[i])) {
			differing++

			if (differing <= SEGMENTATION_DIFFERENCES_SHOWN) {
				console.info(`[B1 DIFF] ${label}: ${stringifyJSON(text)}`)
				console.info(`    orig  : ${stringifyJSON(before.pieces)}`)
				console.info(`    pruned: ${stringifyJSON(after.pieces)}`)
			}
		}
	}

	console.info(`[B1] ${label}: ${texts.length.toLocaleString("en-US")} texts, ${differing} diffs`)

	return differing
}

/**
 * The input description B2 builds feeds from: a name, an element type, and a shape whose
 * entries are sizes or the symbolic dimensions `batch` and `sequence`.
 */
export interface InputMeta {
	name: string
	type: string
	shape: readonly (number | string)[]
}

/**
 * A feed's element type, values and shape.
 */
export interface Feed {
	type: "int64" | "float32"
	data: BigInt64Array | Float32Array
	dims: number[]
}

/**
 * One input's feed for `ids`: the ids for `input_ids`, ones for `attention_mask`,
 * zeros for every other input.
 */
export function feedsFor(metas: readonly InputMeta[], ids: readonly number[]): Record<string, Feed> {
	const feeds: Record<string, Feed> = {}

	for (const meta of metas) {
		const type = meta.type.includes("int64") ? "int64" : "float32"

		const dims = meta.shape.map((dim) => {
			if (dim === "batch") return 1

			if (dim === "sequence") return ids.length
			const size = Number(dim)

			if (!Number.isInteger(size)) throw new Error(`input ${meta.name} has the unresolved dimension ${dim}`)

			return size
		})

		const size = dims.reduce((product, d) => product * d, 1)
		let data: BigInt64Array | Float32Array

		if (meta.name === "input_ids") {
			data = BigInt64Array.from(ids, (id) => BigInt(id))
		} else if (type === "int64") {
			data = new BigInt64Array(size).fill(meta.name === "attention_mask" ? 1n : 0n)
		} else {
			data = new Float32Array(size).fill(meta.name === "attention_mask" ? 1 : 0)
		}

		feeds[meta.name] = { type, data, dims }
	}

	return feeds
}

/**
 * A session's metadata and a call that answers its outputs, in output order, for one set of feeds.
 */
export interface LogitSession {
	inputs: readonly InputMeta[]
	run(feeds: Record<string, Feed>): Promise<Float32Array[]>
}

function bytesOf(values: ArrayBufferView): Buffer {
	return Buffer.from(values.buffer, values.byteOffset, values.byteLength)
}

/**
 * B2: the number of `texts` the two models answer differently, bit for bit.
 *
 * An unmapped id is refused, because the comparison would score a graph against inputs it cannot represent.
 */
export async function checkLogitParity(
	original: PieceEncoder,
	oldToNew: readonly number[],
	originalSession: LogitSession,
	prunedSession: LogitSession,
	texts: readonly string[]
): Promise<number> {
	let differing = 0

	for (const text of texts) {
		const ids = original.encode(text).ids
		const mapped = ids.map((id) => oldToNew[id] ?? -1)

		if (mapped.includes(-1)) throw new Error(`unmapped id in B2 input: ${stringifyJSON(text)}`)
		const before = await originalSession.run(feedsFor(originalSession.inputs, ids))
		const after = await prunedSession.run(feedsFor(prunedSession.inputs, mapped))

		for (let k = 0; k < before.length; k++) {
			if (!bytesOf(before[k]!).equals(bytesOf(after[k]!))) {
				differing++

				if (differing <= LOGIT_DIFFERENCES_SHOWN) {
					let largest = 0

					before[k]!.forEach((v, i) => (largest = Math.max(largest, Math.abs(v - after[k]![i]!))))

					console.info(`[B2 DIFF] ${stringifyJSON(text)}: max |Δ| ${largest}`)
				}

				break
			}
		}
	}

	console.info(`[B2] ${texts.length} inputs, ${differing} non-bit-equal`)

	return differing
}

/**
 * An onnxruntime-node session over `path`, with four intra-op threads on the CPU.
 */
async function openLogitSession(path: string): Promise<LogitSession & AsyncDisposable> {
	const ort = await import("onnxruntime-node")

	const session = await ort.InferenceSession.create(path, {
		intraOpNumThreads: 4,
		executionProviders: ["cpu"],
	})

	const inputs = session.inputMetadata.flatMap((meta) =>
		meta.isTensor ? [{ name: meta.name, type: meta.type, shape: meta.shape }] : []
	)

	return {
		inputs,
		async run(feeds) {
			const tensors = Object.fromEntries(
				Object.entries(feeds).map(([name, feed]) => [name, new ort.Tensor(feed.type, feed.data, feed.dims)])
			)

			const outputs = await session.run(tensors)

			return session.outputNames.map((name) => outputs[name]!.data as Float32Array)
		},
		[Symbol.asyncDispose]: () => session.release(),
	}
}

export interface VerifyPruneOptions {
	originalTokenizer: string
	originalONNX: string
	prunedDirectory: string
	manifest: string
	evalTexts: string
	sampleRows?: number
	logitInputs?: number
	seed?: number
	/**
	 * Rewrites the manifest's build-machine prefix onto this host: each train path
	 * starting with `from` is read under `to`.
	 */
	remap: readonly [from: string, to: string]
}

export interface VerifyReport {
	b1_eval_texts: number
	b1_train_sample: number
	b1_diffs: number
	b2_inputs: number
	b2_diffs: number
	verdict: "PASS" | "FAIL"
}

/**
 * Run B1 and B2 over a pruned directory and write `verify-report.json` into it.
 */
export async function verifyPrune(options: VerifyPruneOptions): Promise<VerifyReport> {
	const seed = options.seed ?? 42
	const { old_to_new: oldToNew } = await readLocalJSONFile<PruneIDMap>(`${options.prunedDirectory}/id-map.json`)
	const { texts: evalTexts } = await readLocalJSONFile<{ texts: string[] }>(options.evalTexts)

	await using scratch = await temporaryDirectory("mtf-verify-")
	const listed = await runMTFTokenizer<string[]>(["manifest-train-files", "--manifest", options.manifest])
	const [from, to] = options.remap
	const files = listed.map((path) => (path.startsWith(from) ? to + path.slice(from.length) : path))
	const filesPath = scratch.path("files.json").toString()
	const rowsPath = scratch.path("rows.json").toString()

	await writeLocalJSONFile(files, filesPath)

	await runMTFTokenizer([
		"sample-rows",
		"--files",
		filesPath,
		"--rows",
		String(options.sampleRows ?? 1_000_000),
		"--seed",
		String(seed),
		"--out",
		rowsPath,
	])

	const trainSample = await readLocalJSONFile<string[]>(rowsPath)

	using original = await loadEncoder(options.originalTokenizer)
	using pruned = await loadEncoder(`${options.prunedDirectory}/tokenizer.model`)
	let b1 = checkSegmentationIdentity(original, pruned, oldToNew, evalTexts, "eval-surface")

	b1 += checkSegmentationIdentity(original, pruned, oldToNew, trainSample, "train-sample")

	const picked = await runMTFTokenizer<number[]>([
		"sample-indices",
		"--population",
		String(evalTexts.length),
		"--count",
		String(Math.min(options.logitInputs ?? 256, evalTexts.length)),
		"--seed",
		String(seed),
	])

	const logitTexts = picked.map((i) => evalTexts[i]!)

	await using originalSession = await openLogitSession(options.originalONNX)
	await using prunedSession = await openLogitSession(`${options.prunedDirectory}/model.onnx`)
	const b2 = await checkLogitParity(original, oldToNew, originalSession, prunedSession, logitTexts)

	const verdict = b1 === 0 && b2 === 0 ? "PASS" : "FAIL"

	console.info(`VERDICT: ${verdict} (B1 diffs ${b1}, B2 diffs ${b2})`)

	const report: VerifyReport = {
		b1_eval_texts: evalTexts.length,
		b1_train_sample: trainSample.length,
		b1_diffs: b1,
		b2_inputs: logitTexts.length,
		b2_diffs: b2,
		verdict,
	}

	await writeLocalTextFile(prettyJSON(report, true, 1), `${options.prunedDirectory}/verify-report.json`)

	return report
}
