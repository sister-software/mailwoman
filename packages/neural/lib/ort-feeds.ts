/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure channel packing + output decode shared by the two ONNX runners (`onnx-runner.ts`,
 *   `web-onnx-runner.ts`). Both hosts feed the same fixed-length tensors and read the same
 *   `logits`/`locale_logits`/`span_scores` outputs; this module owns that contract once so the two
 *   cannot drift — the #727 span read was previously duplicated across hosts and held together only
 *   by a parity test. No `onnxruntime-*` import: the runners construct their own `ort.Tensor`s from
 *   the packed `{data, dims}` pairs, which is the only host-specific step.
 */

import { ANCHOR_FEATURE_DIM } from "#anchor-inference"
import { COUNTRY_FEATURE_DIM } from "#country-inference"
import { GAZETTEER_FEATURE_DIM, LOCALITY_SURFACE_FEATURE_DIM, STREET_TYPE_FEATURE_DIM } from "#gazetteer-inference"
import type { RequiredChannels } from "#weights-channels"

/**
 * One soft-feed channel as a caller supplies it to `infer`: per-piece feature rows + per-piece confidence.
 */
export interface InferChannel {
	features: ReadonlyArray<ReadonlyArray<number>>
	confidence: ReadonlyArray<number>
}

/**
 * The evidence-bundle channels (Option-A) as `infer` receives them.
 */
export interface InferEvidenceChannels {
	streetType?: InferChannel
	localitySurface?: InferChannel
}

/**
 * THE `infer()` signature — one exported type for the three call surfaces that previously restated it
 * (`ONNXRunner.infer`, `WebONNXRunner.infer`, and the classifier's `NeuralRunner` contract).
 *
 * @param tokenIDs The id sequence produced by the tokenizer (no special tokens added).
 * @param anchor Optional postcode-anchor channel (#239/#240) — fed only when the graph declares the anchor inputs.
 * @param gazetteer Optional gazetteer-anchor channel (#464) — same feed contract as the postcode anchor.
 * @param country Optional country-lexicon channel (#1104).
 * @param evidence Optional evidence-bundle channels (Option-A).
 */
export type InferFunction = (
	tokenIDs: number[],
	anchor?: InferChannel,
	gazetteer?: InferChannel,
	country?: InferChannel,
	evidence?: InferEvidenceChannels
) => Promise<InferResult>

export interface InferResult {
	/**
	 * Logits per token per label, indexed as `logits[tokenIdx][labelIdx]`.
	 */
	logits: number[][]
	/**
	 * Number of label classes (the inner-dim of the logits tensor).
	 */
	numLabels: number
	/**
	 * Pooled locale-head posterior (`locale_logits` output, LOCALE_COUNTRIES order), when the model exports it (v1.1.0+,
	 * #511 Tier A). Absent on older bundles — consumers must treat undefined as "no address-system detection available".
	 */
	localeLogits?: number[]
	/**
	 * #727 stage-2: per-span type scores from the semi-Markov span head (`span_scores` output, v3.x+). Indexed
	 * `spanScores[tokenIdx][lengthIdx][segmentTypeIdx]` — the segment starting at `tokenIdx`, of length `lengthIdx + 1`
	 * tokens, typed `SEGMENT_TYPES[segmentTypeIdx]` (that axis ships in the weights bundle's `semi-crf-transitions.json`,
	 * never hardcoded — the PLACETYPE_ORDER class).
	 *
	 * Absent on every pre-v3 bundle, so consumers MUST treat undefined as "no span decode available" and fall back to the
	 * BIO path. Fetching it costs ~0.75 ms (CPU, S=128); a runtime that never reads it pays nothing (ORT prunes the
	 * unfetched branch) — measured in `docs/articles/evals/2026-07-15-v301-phase2-export.md`.
	 */
	spanScores?: number[][][]
	/**
	 * Max span length (the `L` axis of {@link spanScores}). Absent iff `spanScores` is.
	 */
	maxSpan?: number
}

/**
 * A packed tensor payload: the typed-array data plus the dims a runner hands to its `ort.Tensor` constructor.
 */
export interface PackedFeed<Data extends Float32Array | BigInt64Array = Float32Array> {
	data: Data
	dims: number[]
}

/**
 * The `{data, dims}` view of an output tensor `decodeInferOutput` reads — structurally satisfied by an `ort.Tensor`
 * whose float32 dtype the export contract guarantees.
 */
export interface OutputTensor {
	readonly data: Float32Array
	readonly dims: readonly number[]
}

/**
 * Pack the token ids into the fixed-length `input_ids`/`attention_mask` pair: pad to `fixedSeqLen` with id 0 + mask 0,
 * truncate if longer. `seqLen` is the real (unpadded) length every downstream read slices to.
 */
export function packTokenFeed(
	tokenIDs: number[],
	fixedSeqLen: number
): { inputIDs: PackedFeed<BigInt64Array>; attentionMask: PackedFeed<BigInt64Array>; seqLen: number } {
	const seqLen = Math.min(tokenIDs.length, fixedSeqLen)
	const padded = new BigInt64Array(fixedSeqLen)
	const mask = new BigInt64Array(fixedSeqLen)

	for (let i = 0; i < seqLen; i++) {
		padded[i] = BigInt(tokenIDs[i]!)
		mask[i] = 1n
	}

	return {
		inputIDs: { data: padded, dims: [1, fixedSeqLen] },
		attentionMask: { data: mask, dims: [1, fixedSeqLen] },
		seqLen,
	}
}

/**
 * Pack one soft-feed channel into its `<prefix>_features` + `<prefix>_confidence` tensors, zero-padded to
 * `fixedSeqLen`. An `undefined` channel packs all zeros — the confidence=0 identity, the model's channel-off behavior
 * for a graph that declares the inputs as mandatory.
 */
function packChannelFeed(
	channel: InferChannel | undefined,
	fixedSeqLen: number,
	seqLen: number,
	dim: number
): { features: PackedFeed; confidence: PackedFeed } {
	const features = new Float32Array(fixedSeqLen * dim)
	const confidence = new Float32Array(fixedSeqLen)

	if (channel) {
		for (let i = 0; i < seqLen; i++) {
			confidence[i] = channel.confidence[i] ?? 0
			const row = channel.features[i]

			if (row) {
				for (let d = 0; d < dim; d++) {
					features[i * dim + d] = row[d] ?? 0
				}
			}
		}
	}

	return {
		features: { data: features, dims: [1, fixedSeqLen, dim] },
		confidence: { data: confidence, dims: [1, fixedSeqLen] },
	}
}

/**
 * Pack every soft-feed channel the graph declares, in feed-name order. EVERY channel is conditioned on the graph's
 * declared inputs: a supplied channel the graph does not declare is never fed (an undeclared feed crashes ORT), and a
 * declared channel the caller did not supply gets the zero-fill confidence=0 identity so the session never throws on a
 * missing required input. The anchor channel historically skipped the declared-input check on the supplied path — an
 * undeclared feed — and now takes the same check as every other channel.
 *
 * `supplied` dims read the channel's own rows; the fallback dim covers the zero-fill path (and, for the evidence
 * channels, a supplied channel with no rows).
 */
export function packSoftChannelFeeds(
	inputNames: readonly string[],
	fixedSeqLen: number,
	seqLen: number,
	anchor?: InferChannel,
	gazetteer?: InferChannel,
	country?: InferChannel,
	evidence?: InferEvidenceChannels
): Array<[name: string, feed: PackedFeed]> {
	const channels = [
		{ prefix: "anchor", channel: anchor, absentDim: ANCHOR_FEATURE_DIM, suppliedEmptyDim: 0 },
		{ prefix: "gazetteer", channel: gazetteer, absentDim: GAZETTEER_FEATURE_DIM, suppliedEmptyDim: 0 },
		{ prefix: "country", channel: country, absentDim: COUNTRY_FEATURE_DIM, suppliedEmptyDim: 0 },
		{
			prefix: "street_type",
			channel: evidence?.streetType,
			absentDim: STREET_TYPE_FEATURE_DIM,
			suppliedEmptyDim: STREET_TYPE_FEATURE_DIM,
		},
		{
			prefix: "locality_surface",
			channel: evidence?.localitySurface,
			absentDim: LOCALITY_SURFACE_FEATURE_DIM,
			suppliedEmptyDim: LOCALITY_SURFACE_FEATURE_DIM,
		},
	] as const

	const entries: Array<[string, PackedFeed]> = []

	for (const { prefix, channel, absentDim, suppliedEmptyDim } of channels) {
		if (!inputNames.includes(`${prefix}_features`)) continue

		const dim = channel ? (channel.features[0]?.length ?? suppliedEmptyDim) : absentDim
		const packed = packChannelFeed(channel, fixedSeqLen, seqLen, dim)

		entries.push([`${prefix}_features`, packed.features], [`${prefix}_confidence`, packed.confidence])
	}

	return entries
}

/**
 * Decode a session's outputs into an {@link InferResult}, sliced to the real `seqLen` (the pad tail is never real).
 * `localeLogits` and `spanScores` are optional exactly as the exports are — absent tensors yield absent fields.
 */
export function decodeInferOutput(
	output: { logits?: OutputTensor; localeLogits?: OutputTensor; spanScores?: OutputTensor },
	seqLen: number
): InferResult {
	const logitsTensor = output.logits

	if (!logitsTensor) throw new Error("ONNX model did not return a `logits` output")
	const data = logitsTensor.data
	// dims are [batch, sequence, labels].
	const numLabels = logitsTensor.dims[2]!

	const logits: number[][] = []

	for (let t = 0; t < seqLen; t++) {
		const row: number[] = new Array(numLabels)
		const base = t * numLabels

		for (let l = 0; l < numLabels; l++) {
			row[l] = data[base + l]!
		}

		logits.push(row)
	}

	// Locale head (#511 Tier A): present on v1.1.0+ exports, absent (and optional) before.
	const localeLogits = output.localeLogits ? Array.from(output.localeLogits.data) : undefined

	// Span head (#727 stage-2): present on v3.x+ exports. Same optional contract as the locale head
	// — a pre-v3 bundle simply has no `span_scores` output and the BIO path is unaffected.
	const spanTensor = output.spanScores
	let spanScores: number[][][] | undefined
	let maxSpan: number | undefined

	if (spanTensor) {
		const spanData = spanTensor.data
		// dims are [batch, sequence, span, type].
		const spanLen = spanTensor.dims[2]!
		const numTypes = spanTensor.dims[3]!
		maxSpan = spanLen
		spanScores = []

		// Only the first `seqLen` token rows are real; the rest is the fixed-length pad tail.
		for (let t = 0; t < seqLen; t++) {
			const perLength: number[][] = new Array(spanLen)

			for (let l = 0; l < spanLen; l++) {
				const row: number[] = new Array(numTypes)
				const base = (t * spanLen + l) * numTypes

				for (let ty = 0; ty < numTypes; ty++) {
					row[ty] = spanData[base + ty]!
				}

				perLength[l] = row
			}

			spanScores.push(perLength)
		}
	}

	return {
		logits,
		numLabels,
		...(localeLogits ? { localeLogits } : {}),
		...(spanScores ? { spanScores, maxSpan } : {}),
	}
}

/**
 * Back-compat inference of the required soft-feature channels from an ONNX model's declared input names (#718). A model
 * that exports `anchor_features` / `gazetteer_features` declared those channels mandatory at train time — feeding zeros
 * is the channel-off identity, but a model TRAINED with the channel is OOD when scored without it. Cards without a
 * `requires` block (every pre-#718 bundle) route through here so the fail-closed guard still protects them.
 * Conventions/bridge are NOT graph-observable (no dedicated input), so they're left undeclared here — only the card
 * declares them.
 */
export function inferRequiredChannelsFromInputs(inputNames: readonly string[]): RequiredChannels {
	const names = new Set(inputNames)

	return {
		...(names.has("anchor_features") ? { anchor: { required: true } } : {}),
		...(names.has("gazetteer_features") ? { gazetteer: { required: true } } : {}),
		...(names.has("country_features") ? { country: { required: true } } : {}),
		...(names.has("street_type_features") ? { street_type: { required: true } } : {}),
		...(names.has("locality_surface_features") ? { locality_surface: { required: true } } : {}),
	}
}
