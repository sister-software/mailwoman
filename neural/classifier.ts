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
import { STAGE2_BIO_LABELS } from "./labels.js"
import type { InferResult } from "./onnx-runner.js"
import { MailwomanTokenizer } from "./tokenizer.js"
import { buildBioEndMask, buildBioStartMask, buildBioTransitionMask, softmax, viterbi } from "./viterbi.js"
import type { ResolveWeightsOpts } from "./weights.js"

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
	/**
	 * Label vocabulary in the order the model emits them. Defaults to Stage 2 (v0.3.0). Stage 2
	 * strictly extends Stage 1 at the same indices, so a v0.2.0 Stage 1 model loaded with this
	 * default still decodes correctly — its emissions only span the first 15 entries.
	 */
	labels?: readonly string[]
	/**
	 * Decoding strategy:
	 *
	 * - `"viterbi"` (default) — linear-chain CRF Viterbi with the BIO structural mask. Prevents
	 *   orphan-`I-*` sequences. If `transitions` is provided, uses learned scores on top.
	 * - `"argmax"` — per-token argmax. Faster but produces structurally invalid sequences. Use only for
	 *   debugging / comparison.
	 */
	decode?: "viterbi" | "argmax"
	/**
	 * Optional learned CRF transition scores. Square matrix of size `labels.length × labels.length`.
	 * Added on top of the structural BIO mask. Future weights releases ship this; today's v3.0.0
	 * weights don't, so the structural mask alone is used.
	 */
	transitions?: number[][]
	/** Optional learned start-of-sequence transition scores per label. */
	startTransitions?: number[]
	/** Optional learned end-of-sequence transition scores per label. */
	endTransitions?: number[]
}

export class NeuralAddressClassifier {
	private readonly labels: readonly string[]
	private readonly decodeMode: "viterbi" | "argmax"
	private readonly transitions: number[][]
	private readonly startTransitions: number[]
	private readonly endTransitions: number[]

	constructor(private readonly cfg: NeuralAddressClassifierConfig) {
		this.labels = cfg.labels ?? STAGE2_BIO_LABELS
		this.decodeMode = cfg.decode ?? "viterbi"
		const structural = buildBioTransitionMask(this.labels)
		if (cfg.transitions) {
			this.transitions = addMatrices(structural, cfg.transitions)
		} else {
			this.transitions = structural
		}
		this.startTransitions = cfg.startTransitions ?? buildBioStartMask(this.labels)
		this.endTransitions = cfg.endTransitions ?? buildBioEndMask(this.labels)
	}

	/**
	 * One-call factory that resolves the weights package (or explicit paths), loads the tokenizer and
	 * ONNX runner, and returns a ready-to-use classifier.
	 *
	 * Resolution order: explicit paths in `opts` → `@mailwoman/neural-weights-<locale>` package →
	 * throws a single actionable error.
	 *
	 * **Node-only.** The dynamic imports keep `OnnxRunner` (onnxruntime-node) + `resolveWeights`
	 * (uses Node fs) out of the static dependency graph, so this file can be bundled for the browser
	 * by `@mailwoman/neural-web`. Calling this method in a browser will throw at runtime — use
	 * `loadNeuralClassifierFromUrls` from `@mailwoman/neural-web` instead.
	 */
	static async loadFromWeights(opts: ResolveWeightsOpts = {}): Promise<NeuralAddressClassifier> {
		// /* webpackIgnore: true */ tells webpack to leave the dynamic import statement intact —
		// it becomes a runtime native ESM import that resolves in Node (which has onnxruntime-node
		// + node:fs) and throws cleanly in a browser if called. Without the directive, webpack
		// pulls onnx-runner / weights into the browser chunk graph + then chokes on the Node-only
		// builtins they reference.
		const [{ OnnxRunner }, { resolveWeights }] = await Promise.all([
			import(/* webpackIgnore: true */ "./onnx-runner.js"),
			import(/* webpackIgnore: true */ "./weights.js"),
		])
		const { modelPath, tokenizerPath } = resolveWeights(opts)
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(tokenizerPath),
			OnnxRunner.create(modelPath),
		])
		return new NeuralAddressClassifier({ tokenizer, runner })
	}

	/** Tokenize → infer → Viterbi (or argmax) → decoder tree. */
	async parse(text: string): Promise<AddressTree> {
		if (text.length === 0) return { raw: text, roots: [] }

		const { pieces, ids } = this.cfg.tokenizer.encode(text)
		const { logits } = await this.cfg.runner.infer(ids)

		const labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions: logits,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
					}).path
				: logits.map((row) => argmaxSoftmax(row).idx)

		const tokens: DecoderToken[] = pieces.map((p, i) => {
			const idx = labelIndices[i]!
			const probs = softmax(logits[i]!)
			return {
				piece: p.piece,
				start: p.start,
				end: p.end,
				label: (this.labels[idx] ?? "O") as DecoderToken["label"],
				confidence: probs[idx]!,
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

/** Element-wise add two square matrices. Used to compose the structural mask + learned transitions. */
function addMatrices(a: number[][], b: number[][]): number[][] {
	const n = a.length
	const out: number[][] = []
	for (let i = 0; i < n; i++) {
		const row = new Array<number>(n)
		for (let j = 0; j < n; j++) row[j] = a[i]![j]! + b[i]![j]!
		out.push(row)
	}
	return out
}
