/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import * as ort from "onnxruntime-web/webgpu"

import type { NeuralRunner } from "#classifier/index"
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
 * Options for {@link WebONNXRunner}.
 */
export interface WebONNXRunnerOpts {
	/**
	 * Whether to try the WebGPU provider before WASM, which defaults to `true`.
	 *
	 * Turn it off where WebGPU is known to fail, because the failed attempt adds latency.
	 */
	useWebGPU?: boolean

	/**
	 * The fixed input sequence length of the model, which defaults to {@link DEFAULT_FIXED_SEQ_LEN}.
	 */
	fixedSeqLen?: number

	/**
	 * The URL prefix from which onnxruntime-web loads its `.wasm` files, such as a self-hosted copy.
	 *
	 * When unset, onnxruntime-web uses its default location.
	 */
	wasmPathsRoot?: string
}

/**
 * The default length to which the web runner pads every token feed.
 * WebGPU needs static input shapes.
 */
export const DEFAULT_FIXED_SEQ_LEN = 128

/**
 * Fetches a URL into bytes and throws on any non-OK status.
 *
 * It uses the platform `fetch` so that `APIClient` and axios stay out of the browser bundle.
 */
export async function fetchBytes(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
	const res = await fetchImpl(url)

	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)

	return new Uint8Array(await res.arrayBuffer())
}

function configureWASMPaths(root: string | undefined): void {
	if (!root) return

	ort.env.wasm.wasmPaths = root
}

function outputTensor(tensor: ort.Tensor): OutputTensor {
	return { data: tensor.data as Float32Array, dims: tensor.dims }
}

/**
 * The execution backend of the web runner's session and the size of the loaded model in bytes.
 */
export interface WebONNXRunnerDiagnostics {
	backend: "webgpu" | "wasm"
	modelBytes: number
}

/**
 * Runs the model in browsers with `onnxruntime-web`.
 *
 * The session is created on the first inference, on WebGPU when allowed and available
 * and on WASM otherwise. {@link WebONNXRunner.diagnostics} stays `null` until then.
 */
export class WebONNXRunner implements NeuralRunner {
	public readonly fixedSeqLen: number
	public diagnostics: WebONNXRunnerDiagnostics | null = null
	#session: ort.InferenceSession | null = null
	#loadPromise: Promise<ort.InferenceSession> | null = null
	#generation = 0

	#modelBytes: Uint8Array | null

	readonly #modelByteLength: number
	private readonly opts: WebONNXRunnerOpts

	private constructor(modelBytes: Uint8Array, opts: WebONNXRunnerOpts) {
		this.#modelBytes = modelBytes
		this.#modelByteLength = modelBytes.byteLength
		this.opts = opts
		this.fixedSeqLen = opts.fixedSeqLen ?? DEFAULT_FIXED_SEQ_LEN
	}

	/**
	 * Creates a runner from model bytes that have already been fetched.
	 */
	static async fromBytes(modelBytes: Uint8Array, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		configureWASMPaths(opts.wasmPathsRoot)
		const runner = new WebONNXRunner(modelBytes, opts)

		return runner
	}

	/**
	 * Fetches the model from a URL and creates a runner from its bytes.
	 */
	static async fromURL(modelURL: string, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		return WebONNXRunner.fromBytes(await fetchBytes(modelURL), opts)
	}

	async #ensureSession(): Promise<ort.InferenceSession> {
		if (this.#session) return this.#session

		if (!this.#loadPromise) {
			const generation = this.#generation

			// A release() during the load increments the generation and frees this session,
			// so a stale load must not store it.
			const adopt = (session: ort.InferenceSession, backend: WebONNXRunnerDiagnostics["backend"]) => {
				if (generation !== this.#generation) return session

				this.#session = session
				this.diagnostics = { backend, modelBytes: this.#modelByteLength }
				this.#modelBytes = null

				return session
			}

			this.#loadPromise = (async () => {
				const modelBytes = this.#modelBytes

				if (!modelBytes) throw new Error("the ONNX runner has been released")

				const wantWebGPU = this.opts.useWebGPU !== false

				if (wantWebGPU) {
					try {
						const session = await ort.InferenceSession.create(modelBytes, {
							executionProviders: ["webgpu", "wasm"],
							graphOptimizationLevel: "all",
						})

						return adopt(session, "webgpu")
					} catch {}
				}

				const session = await ort.InferenceSession.create(modelBytes, {
					executionProviders: ["wasm"],
					graphOptimizationLevel: "all",
				})

				return adopt(session, "wasm")
			})()
		}

		return this.#loadPromise
	}

	/**
	 * Frees the session's native memory in the WASM heap or on the GPU,
	 * which garbage collection never reclaims.
	 *
	 * It may be called more than once.
	 * When a load is in progress, it waits for the session and then releases it.
	 */
	async release(): Promise<void> {
		this.#modelBytes = null

		this.#generation++

		const pending = this.#loadPromise

		this.#loadPromise = null
		this.#session = null

		if (!pending) return

		try {
			const session = await pending

			await session.release()
		} catch {}
	}

	/**
	 * The loaded graph's declared input names, or `null` before the first inference creates the session.
	 *
	 * Callers use them to warn when a model trained with soft-feature channels runs without them.
	 */
	get inputNames(): readonly string[] | null {
		return this.#session?.inputNames ?? null
	}

	/**
	 * Runs a character-input graph on one padded encoding, like `ONNXRunner.inferChars`.
	 */
	inferChars: InferCharsFunction = async (charIDs, attentionMask) => {
		const session = await this.#ensureSession()
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
	 * Runs one token-id sequence like `ONNXRunner.infer`.
	 *
	 * A soft-feature channel is fed only when the graph declares it.
	 * A declared channel that the caller omits is zero-filled, so the session never rejects a missing input.
	 */
	infer: InferFunction = async (tokenIDs, anchor, gazetteer, country, evidence) => {
		const session = await this.#ensureSession()
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
		const logits = output["logits"]
		const localeLogits = output["locale_logits"]
		const spanScores = output["span_scores"]

		return decodeInferOutput(
			{
				...(logits ? { logits: outputTensor(logits) } : {}),
				...(localeLogits ? { localeLogits: outputTensor(localeLogits) } : {}),
				...(spanScores ? { spanScores: outputTensor(spanScores) } : {}),
			},
			seqLen
		)
	}
}
