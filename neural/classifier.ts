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
	buildAddressTree,
	decodeAsJson,
	decodeAsTuples,
	decodeAsXml,
	type AddressTree,
	type ComponentTag,
	type DecoderToken,
} from "@mailwoman/core/decoder"
import { buildAnchorFeatures, type AnchorLookup } from "./anchor-inference.js"
import { buildFstEmissionPriors, type FstMatcherLike } from "./fst-prior.js"
import { STAGE2_BIO_LABELS } from "./labels.js"
import type { InferResult } from "./onnx-runner.js"
import { repairPostcodeLabels } from "./postcode-repair.js"
import { addEmissionMatrix, buildEmissionPriors, type QueryShapeLike } from "./query-shape-prior.js"
import { buildStreetMorphologyEmissionPriors, type StreetMorphologyPriorOpts } from "./street-morphology-prior.js"
import { MailwomanTokenizer } from "./tokenizer.js"
import { repairUnitLabels } from "./unit-repair.js"
import { buildBioEndMask, buildBioStartMask, buildBioTransitionMask, softmax, viterbi } from "./viterbi.js"
import type { ResolveWeightsOpts, ResolvedWeights } from "./weights.js"

/**
 * Structural type the classifier needs from a runner. Lets callers swap the Node-side `OnnxRunner`
 * for a browser-side runner (e.g. `@mailwoman/neural-web`'s `WebOnnxRunner`) without inheritance —
 * the classifier only ever calls `infer(ids)`.
 */
export interface NeuralRunner {
	infer(
		tokenIds: number[],
		anchor?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
	): Promise<InferResult>
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
	/**
	 * Optional postcode-anchor lookup (#239/#240). When set, `parse` builds per-piece anchor features
	 * from the text + this lookup and feeds them to the runner — for models trained with the anchor
	 * channel (exported with the `anchor_features`/`anchor_confidence` ONNX inputs). Omit for plain
	 * models. Load via `loadAnchorLookup` from `./anchor-inference.js`.
	 */
	postcodeAnchorLookup?: AnchorLookup
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
	static async loadFromWeights(
		opts: ResolveWeightsOpts & { postcodeAnchorLookup?: AnchorLookup } = {}
	): Promise<NeuralAddressClassifier> {
		// /* webpackIgnore: true */ tells webpack to leave the dynamic import statement intact —
		// it becomes a runtime native ESM import that resolves in Node (which has onnxruntime-node
		// + node:fs) and throws cleanly in a browser if called. Without the directive, webpack
		// pulls onnx-runner / weights into the browser chunk graph + then chokes on the Node-only
		// builtins they reference.
		const [{ OnnxRunner }, { resolveWeights, readLabelsFromModelCard, readCrfTransitions }] = await Promise.all([
			import(/* webpackIgnore: true */ "./onnx-runner.js"),
			import(/* webpackIgnore: true */ "./weights.js"),
		])
		const resolved: ResolvedWeights = resolveWeights(opts)
		const labels = readLabelsFromModelCard(resolved.modelCardPath)
		const crf = readCrfTransitions(resolved.crfTransitionsPath)
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(resolved.tokenizerPath),
			OnnxRunner.create(resolved.modelPath),
		])
		return new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels,
			transitions: crf?.transitions,
			startTransitions: crf?.startTransitions,
			endTransitions: crf?.endTransitions,
			...(opts.postcodeAnchorLookup ? { postcodeAnchorLookup: opts.postcodeAnchorLookup } : {}),
		})
	}

	/** Tokenize → infer → Viterbi (or argmax) → decoder tree. */
	async parse(text: string, opts?: ParseOpts): Promise<AddressTree> {
		if (text.length === 0) return { raw: text, roots: [] }

		const { pieces, ids } = this.cfg.tokenizer.encode(text)
		// Postcode-anchor channel (#239/#240): build per-piece anchor features from the same lookup the
		// model trained on, fed alongside the ids. No-op when no lookup is configured.
		const anchor = this.cfg.postcodeAnchorLookup
			? buildAnchorFeatures(text, pieces, this.cfg.postcodeAnchorLookup)
			: undefined
		const { logits } = await this.cfg.runner.infer(ids, anchor)

		this.assertEmissionWidth(logits)

		let emissions = opts?.queryShape
			? addEmissionMatrix(
					logits,
					buildEmissionPriors(opts.queryShape, pieces, this.labels, {
						biasScale: opts.queryShapeBiasScale ?? 1.0,
						inputText: text,
					})
				)
			: logits

		if (opts?.fst) {
			emissions = addEmissionMatrix(
				emissions,
				buildFstEmissionPriors(opts.fst, pieces, this.labels, {
					biasScale: opts.fstBiasScale ?? 1.0,
				})
			)
		}

		if (opts?.fstStreetMorphology) {
			emissions = addEmissionMatrix(
				emissions,
				buildStreetMorphologyEmissionPriors(
					opts.fstStreetMorphology,
					pieces,
					this.labels,
					opts.fstStreetMorphologyOpts ?? {}
				)
			)
		}

		const labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
					}).path
				: emissions.map((row) => argmaxSoftmax(row).idx)

		let tokens: DecoderToken[] = pieces.map((p, i) => {
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

		if (opts?.postcodeRepair) {
			tokens = repairPostcodeLabels(text, tokens).tokens
		}
		if (opts?.unitRepair) {
			tokens = repairUnitLabels(text, tokens).tokens
		}

		return buildAddressTree(text, tokens)
	}

	/**
	 * Like `parse`, but also returns the raw per-token logits and piece offsets needed for per-span
	 * logit aggregation (Option C joint-reconcile integration).
	 */
	async parseWithLogits(text: string, opts?: ParseOpts): Promise<ParseWithLogitsResult> {
		if (text.length === 0) {
			return { tree: { raw: text, roots: [] }, logits: [], pieces: [] }
		}
		const { pieces, ids } = this.cfg.tokenizer.encode(text)
		// Postcode-anchor channel (#239/#240): build per-piece anchor features from the same lookup the
		// model trained on, fed alongside the ids. No-op when no lookup is configured.
		const anchor = this.cfg.postcodeAnchorLookup
			? buildAnchorFeatures(text, pieces, this.cfg.postcodeAnchorLookup)
			: undefined
		const { logits } = await this.cfg.runner.infer(ids, anchor)

		this.assertEmissionWidth(logits)

		let emissions = opts?.queryShape
			? addEmissionMatrix(
					logits,
					buildEmissionPriors(opts.queryShape, pieces, this.labels, {
						biasScale: opts.queryShapeBiasScale ?? 1.0,
						inputText: text,
					})
				)
			: logits

		if (opts?.fst) {
			emissions = addEmissionMatrix(
				emissions,
				buildFstEmissionPriors(opts.fst, pieces, this.labels, {
					biasScale: opts.fstBiasScale ?? 1.0,
				})
			)
		}

		if (opts?.fstStreetMorphology) {
			emissions = addEmissionMatrix(
				emissions,
				buildStreetMorphologyEmissionPriors(
					opts.fstStreetMorphology,
					pieces,
					this.labels,
					opts.fstStreetMorphologyOpts ?? {}
				)
			)
		}

		const labelIndices =
			this.decodeMode === "viterbi"
				? viterbi({
						emissions,
						transitions: this.transitions,
						startTransitions: this.startTransitions,
						endTransitions: this.endTransitions,
					}).path
				: emissions.map((row) => argmaxSoftmax(row).idx)

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

		return {
			tree: buildAddressTree(text, tokens),
			logits,
			pieces: pieces.map((p) => ({ start: p.start, end: p.end })),
		}
	}

	async parseJson(text: string, opts?: ParseOpts): Promise<Partial<Record<ComponentTag, string>>> {
		return decodeAsJson(await this.parse(text, opts))
	}

	async parseTuples(text: string, opts?: ParseOpts): Promise<Array<[ComponentTag, string]>> {
		return decodeAsTuples(await this.parse(text, opts))
	}

	async parseXml(text: string, opts?: ParseOpts & { xml?: Parameters<typeof decodeAsXml>[1] }): Promise<string> {
		return decodeAsXml(await this.parse(text, opts), opts?.xml)
	}

	/**
	 * Guard against a silent label/emission shape overrun. When the model emits MORE logits per token
	 * than the configured label vocabulary (e.g. a Stage 3 bundle loaded with the default Stage 2
	 * labels), viterbi indexes past the transition matrix and dies with an opaque `Cannot read
	 * properties of undefined (reading '0')`. Fail fast here with a message that names the contract
	 * the caller violated.
	 *
	 * The opposite shape (model narrower than labels) is intentionally permitted — STAGE2_BIO_LABELS
	 * prefix-extends STAGE1_BIO_LABELS so a Stage 1 model loaded with Stage 2 labels decodes
	 * correctly via the first 15 logits. See labels.ts for the contract.
	 */
	private assertEmissionWidth(logits: readonly number[][]): void {
		if (logits.length === 0) return
		const width = logits[0]!.length
		if (width > this.labels.length) {
			throw new Error(
				`Label/emission mismatch: model emits ${width} logits per token but the classifier was ` +
					`configured with only ${this.labels.length} labels. Did you load a Stage 3 bundle without ` +
					`passing its model-card labels? See loadFromWeights / loadNeuralClassifierFromUrls.`
			)
		}
	}
}

/** Result of `parseWithLogits` — tree + raw material for per-span logit aggregation. */
export interface ParseWithLogitsResult {
	tree: AddressTree
	logits: number[][]
	pieces: Array<{ start: number; end: number }>
}

/**
 * Per-call opts for `parse()`. Threading a precomputed `QueryShape` here turns on the soft-prior
 * bias path in the Viterbi decoder (Stage 2.4 boundary → Stage 3 encoder integration).
 */
export interface ParseOpts {
	/**
	 * Precomputed `QueryShape` for this input (from `@mailwoman/query-shape`'s `computeQueryShape`).
	 * Known-format hits in the shape produce additive emission biases toward the matching BIO label.
	 * Typed structurally — no runtime dependency on `@mailwoman/query-shape`.
	 */
	queryShape?: QueryShapeLike
	/**
	 * Maximum bias magnitude in log-odds units. Default 1.0 — adds up to ~e^1 ≈ 2.7× odds to the
	 * favored label. Confidence-scaled, so a 0.6-confidence format hit gets +0.6 max bias.
	 */
	queryShapeBiasScale?: number
	/**
	 * Pre-built FST gazetteer matcher. When provided, gazetteer matches produce additive emission
	 * biases.
	 */
	fst?: FstMatcherLike
	/** Bias magnitude for FST gazetteer matches. Default 1.0. */
	fstBiasScale?: number
	/**
	 * Pre-built street-morphology FST matcher. When provided, street-type affixes (Avenue, rue,
	 * Calle, Straße, …) produce additive emission biases toward `street_prefix`/`street_suffix` on
	 * the matched tokens AND toward `street` / away from `dependent_locality` on the adjacent name
	 * tokens. Closes the v0.6.1 dependent_locality vacuum; see
	 * `docs/articles/concepts/street-supplement-architecture.md` for the layered design.
	 */
	fstStreetMorphology?: FstMatcherLike
	/** Override bias magnitudes for the morphology prior. */
	fstStreetMorphologyOpts?: StreetMorphologyPriorOpts
	/**
	 * When true, run the deterministic postcode regex repair pass (v0.7 #35) on the decoded label
	 * sequence before tree-building. Detects postcode-shaped substrings (GB/CA/NL/US/FR/… patterns)
	 * and snaps/adds the postcode span to the matched shape, fixing the SentencePiece-fragmentation
	 * failures catalogued in the 2026-05-29 postcode diagnostic. Off by default — opt-in until the
	 * v0.7 gate confirms it. See `./postcode-repair.ts`.
	 */
	postcodeRepair?: boolean
	/**
	 * When true, run the deterministic secondary-unit regex repair pass on the decoded label sequence
	 * before tree-building. Detects designator-shaped substrings ("Apt 4B", "Ste 12", "Unit 9400",
	 * bare "#104", …) and snaps/adds the unit span, fixing the unit-drop weakness the three-arena
	 * capability eval surfaced (postal secondary-unit 0% neural). Off by default — opt-in until the
	 * v0.7.2 arena re-run quantifies its delta. See `./unit-repair.ts`.
	 */
	unitRepair?: boolean
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
