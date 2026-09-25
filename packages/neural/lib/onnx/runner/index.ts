/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import ort from "onnxruntime-node"
import type { PathBuilderLike } from "path-ts"

import {
	decodeInferOutput,
	packCharFeed,
	packSoftChannelFeeds,
	packTokenFeed,
	type InferCharsFunction,
	type InferFunction,
	type OutputTensor,
} from "#ort-feeds"

/**
 * Re-exports the evidence feature widths from the browser-safe gazetteer inference module.
 */
export { LOCALITY_SURFACE_FEATURE_DIM, STREET_TYPE_FEATURE_DIM } from "#gazetteer-inference"

/**
 * Re-exports the character feed packer, which lives in the pure feed module shared with the browser runner.
 */
export { packCharFeed } from "#ort-feeds"
/**
 * Re-exports the inference result type from the feed module shared with the browser runner.
 */
export type { InferResult } from "#ort-feeds"

/**
 * Configures an {@link ONNXRunner}.
 *
 * The runner always appends a CPU fallback to the requested execution providers.
 */
export interface ONNXRunnerOpts {
	/**
	 * Whether `create()` loads the session immediately instead of on first inference.
	 * It defaults to `false`.
	 */
	warmup?: boolean

	/**
	 * The fixed input sequence length of the model, which defaults to {@link DEFAULT_FIXED_SEQ_LEN}.
	 *
	 * Shorter inputs are padded with id 0 and masked out.
	 * Longer inputs are truncated.
	 */
	fixedSeqLen?: number

	/**
	 * ONNX Runtime execution providers in priority order, such as `["cuda", "cpu"]`.
	 * It defaults to `["cpu"]`.
	 *
	 * The runner appends `cpu` when it is missing.
	 * GPU providers throw when they fail to initialize, so the runner then retries on CPU alone.
	 */
	executionProviders?: string[]

	/**
	 * The maximum intra-op thread count for one operator.
	 *
	 * When unset, ONNX Runtime uses every core, which oversubscribes the machine
	 * when several processes run at once.
	 */
	intraOpNumThreads?: number
}

/**
 * The default model sequence length in pieces.
 */
export const DEFAULT_FIXED_SEQ_LEN = 128

/**
 * The default ONNX Runtime intra-op thread count.
 * `MAILWOMAN_INTRA_OP_THREADS` overrides it per process.
 *
 * A multi-worker server should set the override to about the core count divided by the worker count.
 */
export const DEFAULT_INTRA_OP_THREADS = 2

function outputTensor(tensor: ort.Tensor): OutputTensor {
	return { data: tensor.data as Float32Array, dims: tensor.dims }
}

/**
 * Runs a token-input or character-input ONNX model in Node.
 *
 * The session loads lazily from a path or from bytes.
 * The runner falls back to the CPU provider when the requested providers fail to initialize.
 */
export class ONNXRunner {
	private session: ort.InferenceSession | null = null
	private loadPromise: Promise<ort.InferenceSession> | null = null
	public readonly fixedSeqLen: number

	private readonly executionProviders: string[]
	private readonly intraOpNumThreads: number | undefined
	private readonly modelPath: PathBuilderLike
	private readonly modelBytes: Uint8Array | null

	private constructor(modelPath: PathBuilderLike, modelBytes: Uint8Array | null, opts: ONNXRunnerOpts) {
		this.modelPath = modelPath
		this.modelBytes = modelBytes
		this.fixedSeqLen = opts.fixedSeqLen ?? DEFAULT_FIXED_SEQ_LEN
		const requested = opts.executionProviders ?? ["cpu"]

		this.executionProviders = requested.includes("cpu") ? requested : [...requested, "cpu"]
		this.intraOpNumThreads = opts.intraOpNumThreads
	}

	/**
	 * Creates a runner for the model at `modelPath`, reading it on first inference unless `warmup` is set.
	 */
	static async create(modelPath: PathBuilderLike, opts: ONNXRunnerOpts = {}): Promise<ONNXRunner> {
		const runner = new ONNXRunner(modelPath, null, opts)

		if (opts.warmup) {
			await runner.ensureSession()
		}

		return runner
	}

	/**
	 * Creates a runner from model bytes that have already been read.
	 */
	static async fromBytes(modelBytes: Uint8Array, opts: ONNXRunnerOpts = {}): Promise<ONNXRunner> {
		const runner = new ONNXRunner("(bytes)", modelBytes, opts)

		if (opts.warmup) {
			await runner.ensureSession()
		}

		return runner
	}

	private async ensureSession(): Promise<ort.InferenceSession> {
		if (this.session) return this.session

		if (!this.loadPromise) {
			this.loadPromise = (async () => {
				const bytes = this.modelBytes ?? new Uint8Array(await readLocalBuffer(this.modelPath))
				this.session = await this.createSession(bytes)

				return this.session
			})()
		}

		return this.loadPromise
	}

	/**
	 * Creates the session on the configured providers and retries on CPU alone if they fail to initialize.
	 */
	private async createSession(bytes: Uint8Array): Promise<ort.InferenceSession> {
		try {
			return await ort.InferenceSession.create(bytes, {
				executionProviders: this.executionProviders,
				graphOptimizationLevel: "all",
				...(this.intraOpNumThreads ? { intraOpNumThreads: this.intraOpNumThreads } : {}),
			})
		} catch (error) {
			if (this.executionProviders.length === 1 && this.executionProviders[0] === "cpu") throw error

			console.warn(
				`[ONNXRunner] execution providers [${this.executionProviders.join(", ")}] failed to initialize ` +
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- In-memory error message. only its first line is logged.
					`(${(error as Error).message.split("\n")[0]}); falling back to CPU.`
			)

			return ort.InferenceSession.create(bytes, {
				executionProviders: ["cpu"],
				graphOptimizationLevel: "all",
				...(this.intraOpNumThreads ? { intraOpNumThreads: this.intraOpNumThreads } : {}),
			})
		}
	}

	/**
	 * Runs one token-id sequence, padded or truncated to `fixedSeqLen`,
	 * and trims the output to the real length.
	 *
	 * A soft-feature channel is fed only when the graph declares it.
	 * A declared channel that the caller omits is zero-filled.
	 */
	infer: InferFunction = async (tokenIDs, anchor, gazetteer, country, evidence) => {
		const session = await this.ensureSession()
		const { inputIDs, attentionMask, seqLen } = packTokenFeed(tokenIDs, this.fixedSeqLen)

		const feeds: Record<string, ort.Tensor> = {
			input_ids: new ort.Tensor("int64", inputIDs.data, inputIDs.dims),
			attention_mask: new ort.Tensor("int64", attentionMask.data, attentionMask.dims),
		}

		const packed = packSoftChannelFeeds(
			session.inputNames,
			this.fixedSeqLen,
			seqLen,
			anchor,
			gazetteer,
			country,
			evidence
		)

		for (const [name, feed] of packed) {
			feeds[name] = new ort.Tensor("float32", feed.data, feed.dims)
		}

		const output = await session.run(feeds)

		return decodeInferOutput(
			{
				...(output.logits ? { logits: outputTensor(output.logits) } : {}),
				...(output.locale_logits ? { localeLogits: outputTensor(output.locale_logits) } : {}),
				...(output.span_scores ? { spanScores: outputTensor(output.span_scores) } : {}),
			},
			seqLen
		)
	}

	/**
	 * Runs a character-input graph on one padded encoding and trims the output to the real unit count.
	 *
	 * The character path takes no soft-feature channels.
	 */
	inferChars: InferCharsFunction = async (charIDs, attentionMask) => {
		const session = await this.ensureSession()
		const packed = packCharFeed(charIDs, attentionMask)

		const output = await session.run({
			char_ids: new ort.Tensor("int64", packed.charIDs.data, packed.charIDs.dims),
			attention_mask: new ort.Tensor("int64", packed.attentionMask.data, packed.attentionMask.dims),
		})

		return decodeInferOutput(
			{
				...(output.logits ? { logits: outputTensor(output.logits) } : {}),
				...(output.locale_logits ? { localeLogits: outputTensor(output.locale_logits) } : {}),
			},
			packed.seqLen
		)
	}

	/**
	 * Returns the graph's declared input names, loading the session if needed.
	 *
	 * Callers infer the required soft-feature channels from these names
	 * when the model card has no `requires` block.
	 */
	async inputNames(): Promise<readonly string[]> {
		const session = await this.ensureSession()

		return session.inputNames
	}
}
