/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ONNX inference wrapper.
 *
 *   Loads a token-classification model exported by `packages/corpus-python/src/mailwoman_train/
 *   export_onnx.py` (BertForTokenClassification w/ inputs `input_ids` + `attention_mask`, output
 *   `logits` shape `[batch, sequence, num_labels]`).
 *
 *   Lazy-loads on first `infer()` call unless `warmup: true` is passed; the constructor itself is
 *   cheap and synchronous.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import ort from "onnxruntime-node"
import type { PathBuilderLike } from "path-ts"

import {
	decodeInferOutput,
	packSoftChannelFeeds,
	packTokenFeed,
	type InferFunction,
	type OutputTensor,
} from "#ort-feeds"

// Back-compat: the dims moved to gazetteer-inference.ts (browser-safe) so neural-web's runner can
// import them without touching this node-only module.
export { LOCALITY_SURFACE_FEATURE_DIM, STREET_TYPE_FEATURE_DIM } from "#gazetteer-inference"
// Back-compat: the result type moved to ort-feeds.ts (pure, shared with the browser runner).
export type { InferResult } from "#ort-feeds"

export interface ONNXRunnerOpts {
	/**
	 * If true, load the model immediately in `create()`. Default false.
	 */
	warmup?: boolean
	/**
	 * Fixed sequence length the model expects. v0.1.0 / v0.2.0 quantization baked in 128 (the training-time max position)
	 * even though the fp32 export specified dynamic axes — re-quantize with a different shape to override. Inputs shorter
	 * than this are padded with id `0` and masked out via attention_mask=0; inputs longer are truncated.
	 */
	fixedSeqLen?: number
	/**
	 * ONNX Runtime execution providers to try, in priority order — e.g. `["cuda", "cpu"]` or `["webgpu", "cpu"]`.
	 * **Default `["cpu"]`** (unchanged behavior). GPU providers (`cuda`, `webgpu`) THROW at session-create when their
	 * runtime/driver is absent rather than soft-falling-back, so this is **guarded**: if the requested list fails to
	 * initialize, the runner retries on CPU alone. The cost of a failed GPU probe is a one-time sub-`100 ms` hit at load,
	 * so a GPU box lights up and a CPU box pays ~nothing. `cpu` is always appended if not present.
	 */
	executionProviders?: string[]
	/**
	 * Cap ONNX Runtime's INTRA-op thread pool — the threads a single operator splits its work across.
	 *
	 * Unset means ORT sizes the pool to the machine's core count. That is the right default for a server running one
	 * session over long sequences, and the wrong one for the shape this repo actually runs: short addresses, frequently
	 * several processes at once. Every CLI invocation is its own session, so N concurrent processes each claim every
	 * core, and the oversubscription surfaces as latency rather than error — measured 2026-08-03, eight concurrent
	 * `mailwoman geocode` calls took 8.75 s against a 10 s test timeout on an otherwise idle 16-core box, where one alone
	 * took 5.62 s.
	 *
	 * Set it when the caller knows it is one of many, or when sequences are short enough that thread coordination costs
	 * more than the parallelism returns.
	 */
	intraOpNumThreads?: number
}

/**
 * Default sequence length for v0.1.0 / v0.2.0 (BertConfig max_position_embeddings = 128).
 */
export const DEFAULT_FIXED_SEQ_LEN = 128

/**
 * Intra-op thread cap applied by `NeuralAddressClassifier.loadFromWeights`, overridable per-process via
 * `MAILWOMAN_INTRA_OP_THREADS`.
 *
 * THERE IS NO VALUE THAT IS RIGHT FOR BOTH REGIMES, which is why this is a knob with a compromise default rather than a
 * tuned constant. Measured on a 16-core box:
 *
 * - ONE process, 120 warm parses: 1 thread 18.3 ms/parse, 2 threads 12.5, 4 threads 9.2, ORT's all-cores default 9.3.
 *   More threads win; the parallelism is doing real work.
 * - FOUR concurrent processes, full geocode: 1 thread 32 req/s each, 2 threads 45, 4 threads 33. Fewer threads win,
 *   because N processes each sizing a pool to the machine oversubscribe it N-fold.
 *
 * Two is the compromise: it costs a single process ~35% latency against its own optimum, and buys a four-process server
 * ~36% throughput against the single-process optimum applied blindly. A server that knows its own worker count should
 * set `MAILWOMAN_INTRA_OP_THREADS` to roughly cores/workers instead of accepting this.
 *
 * Re-derive both curves before changing it. They are properties of the model and the box, and the single-process one
 * alone will point at the wrong answer.
 */
export const DEFAULT_INTRA_OP_THREADS = 2

/**
 * The `{data, dims}` view `decodeInferOutput` reads. The float32 dtype is the export contract's, not a runtime check.
 */
function outputTensor(tensor: ort.Tensor): OutputTensor {
	return { data: tensor.data as Float32Array, dims: tensor.dims }
}

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
		// CPU is the universal final fallback — append it so a GPU-only list still has somewhere to land.
		this.executionProviders = requested.includes("cpu") ? requested : [...requested, "cpu"]
		this.intraOpNumThreads = opts.intraOpNumThreads
	}

	/**
	 * Load by path. Reads the model lazily unless `warmup` is true.
	 */
	static async create(modelPath: PathBuilderLike, opts: ONNXRunnerOpts = {}): Promise<ONNXRunner> {
		const runner = new ONNXRunner(modelPath, null, opts)

		if (opts.warmup) {
			await runner.ensureSession()
		}

		return runner
	}

	/**
	 * Load from an already-read byte buffer.
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
	 * Create the session on the configured execution providers, guarded: GPU providers (`cuda`/`webgpu`) throw at
	 * create-time when their runtime/driver is missing, so on failure we retry on CPU alone. A box with the GPU runtime
	 * uses it; a box without one transparently lands on CPU.
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

			// A requested GPU provider failed to initialize — fall back to CPU so inference still loads.
			console.warn(
				`[ONNXRunner] execution providers [${this.executionProviders.join(", ")}] failed to initialize ` +
					// oxlint-disable-next-line mailwoman/prefer-spliterator -- In-memory error message; only its first line is logged.
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
	 * Run inference on a single token id sequence — see {@link InferFunction} for the parameter contract.
	 *
	 * Pads to `fixedSeqLen` (default 128) with id 0 + mask 0; truncates if longer. Output is sliced back to the actual
	 * input length. Every soft-feed channel is present-conditional on the graph's declared inputs, with the zero-fill
	 * confidence=0 identity for a declared-but-unsupplied channel (`packSoftChannelFeeds`).
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
	 * The model's declared input names (loads the session if not already loaded). Used by the ProductionScorer (#718)
	 * back-compat path: when a model-card has no `requires` block, the required soft-feature channels are INFERRED from
	 * the graph — a model exporting `anchor_features` / `gazetteer_features` declared those channels mandatory at train
	 * time.
	 */
	async inputNames(): Promise<readonly string[]> {
		const session = await this.ensureSession()

		return session.inputNames
	}
}
