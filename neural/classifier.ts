/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `NeuralAddressClassifier` ties together the tokenizer, the ONNX inference runner, and the
 *   `@mailwoman/core` decoder. Single user-facing entrypoint: `parse(text)` returns an
 *   `AddressTree` ready for projection into JSON / tuple / XML.
 *
 *   Convenience wrappers `parseJson` / `parseTuples` / `parseXml` project the tree on the way out.
 */

import {
	type AddressTree,
	type ComponentTag,
	type DecoderToken,
	buildAddressTree,
	decodeAsJson,
	decodeAsTuples,
	decodeAsXml,
} from "@mailwoman/core/decoder"
import { STAGE1_BIO_LABELS } from "./labels.js"
import { type InferResult, OnnxRunner } from "./onnx-runner.js"
import { MailwomanTokenizer } from "./tokenizer.js"
import { type ResolveWeightsOpts, resolveWeights } from "./weights.js"

/**
 * Structural type the classifier needs from a runner. Lets callers swap the Node-side `OnnxRunner`
 * for a browser-side runner (e.g. `@mailwoman/neural-web`'s `WebOnnxRunner`) without inheritance —
 * the classifier only ever calls `infer(ids)`.
 */
export interface NeuralRunner {
	infer(tokenIds: number[]): Promise<InferResult>
}

export interface NeuralAddressClassifierConfig {
	tokenizer: MailwomanTokenizer
	runner: NeuralRunner
	/** Label vocabulary in the order the model emits them. Defaults to Stage 1 (v0.1.0/v0.2.0). */
	labels?: readonly string[]
}

export class NeuralAddressClassifier {
	private readonly labels: readonly string[]

	constructor(private readonly cfg: NeuralAddressClassifierConfig) {
		this.labels = cfg.labels ?? STAGE1_BIO_LABELS
	}

	/**
	 * One-call factory that resolves the weights package (or explicit paths), loads the tokenizer and
	 * ONNX runner, and returns a ready-to-use classifier.
	 *
	 * Resolution order: explicit paths in `opts` → `@mailwoman/neural-weights-<locale>` package →
	 * throws a single actionable error.
	 */
	static async loadFromWeights(opts: ResolveWeightsOpts = {}): Promise<NeuralAddressClassifier> {
		const { modelPath, tokenizerPath } = resolveWeights(opts)
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(tokenizerPath),
			OnnxRunner.create(modelPath),
		])
		return new NeuralAddressClassifier({ tokenizer, runner })
	}

	/** Tokenize → infer → argmax/softmax → decoder tree. */
	async parse(text: string): Promise<AddressTree> {
		if (text.length === 0) return { raw: text, roots: [] }

		const { pieces, ids } = this.cfg.tokenizer.encode(text)
		const { logits } = await this.cfg.runner.infer(ids)

		const tokens: DecoderToken[] = pieces.map((p, i) => {
			const row = logits[i]!
			const { idx, conf } = argmaxSoftmax(row)
			return {
				piece: p.piece,
				start: p.start,
				end: p.end,
				label: (this.labels[idx] ?? "O") as DecoderToken["label"],
				confidence: conf,
			}
		})

		return buildAddressTree(text, tokens)
	}

	async parseJson(text: string): Promise<Partial<Record<ComponentTag, string>>> {
		return decodeAsJson(await this.parse(text))
	}

	async parseTuples(text: string): Promise<Array<[ComponentTag, string]>> {
		return decodeAsTuples(await this.parse(text))
	}

	async parseXml(text: string, opts?: Parameters<typeof decodeAsXml>[1]): Promise<string> {
		return decodeAsXml(await this.parse(text), opts)
	}
}

function argmaxSoftmax(row: number[]): { idx: number; conf: number } {
	let maxIdx = 0
	let maxVal = row[0]!
	for (let i = 1; i < row.length; i++) {
		if (row[i]! > maxVal) {
			maxVal = row[i]!
			maxIdx = i
		}
	}
	let sumExp = 0
	for (const v of row) sumExp += Math.exp(v - maxVal)
	const conf = 1 / sumExp
	return { idx: maxIdx, conf }
}
