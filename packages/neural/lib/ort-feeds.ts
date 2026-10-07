/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure channel packing + output decode shared by both ONNX runners, so the fixed-length tensor
 *   feeds and the `logits`/`locale_logits`/`span_scores` reads cannot drift. It imports no
 *   `onnxruntime-*` because each runner constructs its own `ort.Tensor`s from the packed
 *   `{data, dims}` pairs.
 */

import { ANCHOR_FEATURE_DIM } from "#anchor-inference"
import { COUNTRY_FEATURE_DIM } from "#country-inference"
import { GAZETTEER_FEATURE_DIM, LOCALITY_SURFACE_FEATURE_DIM, STREET_TYPE_FEATURE_DIM } from "#gazetteer-inference"
import type { RequiredChannels } from "#weights/channels"

/**
 * One soft-feed channel as a caller supplies it to `infer`.
 */
export interface InferChannel {
	features: ReadonlyArray<ReadonlyArray<number>>
	confidence: ReadonlyArray<number>
}

/**
 * The evidence-bundle channels as `infer` receives them.
 */
export interface InferEvidenceChannels {
	streetType?: InferChannel | null
	localitySurface?: InferChannel | null
	/**
	 * The address-system id for a graph with a `locale_hint` input.
	 *
	 * The model card's `address_systems.no_hint` id states that no hint is given.
	 */
	localeHint?: number
}

/**
 * The shared `infer()` signature implemented by `ONNXRunner.infer`, `WebONNXRunner.infer`
 * and the classifier's `NeuralRunner` interface.
 */
export type InferFunction = (
	tokenIDs: number[],
	anchor?: InferChannel | null,
	gazetteer?: InferChannel | null,
	country?: InferChannel | null,
	evidence?: InferEvidenceChannels
) => Promise<InferResult>

/**
 * The char-path twin of {@link InferFunction}: one S-padded encoding in, per-unit logits out.
 */
export type InferCharsFunction = (
	charIDs: ReadonlyArray<readonly number[]>,
	attentionMask: readonly number[]
) => Promise<InferResult>

export interface InferResult {
	logits: number[][]
	numLabels: number
	/**
	 * Pooled locale-head posterior (`locale_logits` output, LOCALE_COUNTRIES order)
	 * when the model exports it.
	 *
	 * Consumers must treat null as no address-system detection available.
	 */
	localeLogits: number[] | null
	/**
	 * The address-system head's logits (`address_system_logits` output), indexed by the
	 * model card's `address_systems` ids, when the model exports it.
	 */
	addressSystemLogits: number[] | null
	/**
	 * Per-span type scores from the semi-Markov span head, indexed
	 * `spanScores[tokenIdx][lengthIdx][segmentTypeIdx]` for a segment of `lengthIdx + 1` tokens.
	 *
	 * Null on bundles without the head, so consumers fall back to the BIO path.
	 */
	spanScores: number[][][] | null
	/**
	 * Max span length (the `L` axis of {@link spanScores}); null iff `spanScores` is.
	 */
	maxSpan: number | null
}

/**
 * A packed tensor payload: the typed-array data plus the dims a runner hands
 * to its `ort.Tensor` constructor.
 */
export interface PackedFeed<Data extends Float32Array | BigInt64Array = Float32Array> {
	data: Data
	dims: number[]
}

/**
 * The `{data, dims}` view of an output tensor `decodeInferOutput` reads, structurally
 * satisfied by an `ort.Tensor` whose float32 dtype the export interface guarantees.
 */
export interface OutputTensor {
	readonly data: Float32Array
	readonly dims: readonly number[]
}

/**
 * Pack the token ids into the fixed-length `input_ids`/`attention_mask` pair —
 * pad to `fixedSeqLen` with id 0 + mask 0 and truncate if longer — and return the
 * real (unpadded) `seqLen` every downstream read trims to.
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
 * Pack a char-path encoding into the two int64 tensors the char graph declares;
 * `seqLen` is the count of real units the logits are trimmed back to.
 */
export function packCharFeed(
	charIDs: ReadonlyArray<readonly number[]>,
	attentionMask: readonly number[]
): { charIDs: PackedFeed<BigInt64Array>; attentionMask: PackedFeed<BigInt64Array>; seqLen: number } {
	const units = charIDs.length
	const width = charIDs[0]?.length ?? 0
	const chars = new BigInt64Array(units * width)
	const mask = new BigInt64Array(units)
	let seqLen = 0

	for (let unit = 0; unit < units; unit++) {
		const row = charIDs[unit]!

		for (let slot = 0; slot < width; slot++) {
			chars[unit * width + slot] = BigInt(row[slot] ?? 0)
		}

		mask[unit] = BigInt(attentionMask[unit] ?? 0)

		if (attentionMask[unit]) {
			seqLen++
		}
	}

	return {
		charIDs: { data: chars, dims: [1, units, width] },
		attentionMask: { data: mask, dims: [1, units] },
		seqLen,
	}
}

/**
 * Pack one soft-feed channel into its `<prefix>_features` + `<prefix>_confidence` tensors, zero-padded
 * to `fixedSeqLen`; a `null` channel packs the confidence=0 identity the model treats as channel-off.
 */
function packChannelFeed(
	channel: InferChannel | null,
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
 * Pack every soft-feed channel the graph declares, in feed-name order: a supplied
 * channel the graph does not declare is never fed (an undeclared feed crashes ORT),
 * and a declared channel the caller omitted gets the zero-fill confidence=0 identity.
 */
export function packSoftChannelFeeds(
	inputNames: readonly string[],
	fixedSeqLen: number,
	seqLen: number,
	anchor?: InferChannel | null,
	gazetteer?: InferChannel | null,
	country?: InferChannel | null,
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
		const packed = packChannelFeed(channel ?? null, fixedSeqLen, seqLen, dim)

		entries.push([`${prefix}_features`, packed.features], [`${prefix}_confidence`, packed.confidence])
	}

	return entries
}

/**
 * The `locale_hint` value a runner feeds when the caller gives no address-system id.
 *
 * The trainer sizes the hint embedding at one row per address system plus a last row for
 * "no hint", so the card's `address_systems.no_hint` is always the last index.
 * The exported graph reads the id with an ONNX `Gather`, which counts a negative index from the end,
 * so `-1` selects that last row without the runner knowing how many systems the model has.
 */
export const NO_LOCALE_HINT = -1

/**
 * Pack the `locale_hint` input when the graph declares one, or return null when it does not.
 *
 * A caller without an id gets {@linkcode NO_LOCALE_HINT}, the trained "no hint" behavior.
 */
export function packLocaleHintFeed(
	inputNames: readonly string[],
	localeHint: number | undefined
): PackedFeed<BigInt64Array> | null {
	if (!inputNames.includes("locale_hint")) return null

	return { data: BigInt64Array.of(BigInt(localeHint ?? NO_LOCALE_HINT)), dims: [1] }
}

/**
 * Decode a session's outputs into an {@link InferResult} trimmed to the real `seqLen`
 * (the pad tail is never real); absent tensors yield absent fields.
 */
export function decodeInferOutput(
	output: {
		logits?: OutputTensor
		localeLogits?: OutputTensor
		spanScores?: OutputTensor
		addressSystemLogits?: OutputTensor
	},
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

	const localeLogits = output.localeLogits ? Array.from(output.localeLogits.data) : null
	const addressSystemLogits = output.addressSystemLogits ? Array.from(output.addressSystemLogits.data) : null

	const spanTensor = output.spanScores
	let spanScores: number[][][] | null = null
	let maxSpan: number | null = null

	if (spanTensor) {
		const spanData = spanTensor.data
		// dims are [batch, sequence, span, type].
		const spanLen = spanTensor.dims[2]!
		const numTypes = spanTensor.dims[3]!
		maxSpan = spanLen
		spanScores = []

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
		localeLogits,
		addressSystemLogits,
		spanScores: maxSpan === null ? null : spanScores,
		maxSpan: spanScores === null ? null : maxSpan,
	}
}

/**
 * Back-compat inference of the required soft-feature channels from a model's declared input names:
 * a graph exporting `<channel>_features` declared that channel mandatory at train time,
 * so cards without a `requires` block route through here and the fail-closed guard still guards them.
 *
 * Conventions/bridge have no dedicated input and stay undeclared.
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
