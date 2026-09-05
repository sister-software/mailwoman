/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser ONNX inference wrapper. Implements the same `NeuralRunner` contract `@mailwoman/neural`'s
 *   classifier consumes, but backed by `onnxruntime-web` (WASM + optional WebGPU) instead of
 *   `onnxruntime-node`.
 *
 *   Execution provider strategy:
 *
 *   - Try WebGPU first when `useWebGPU !== false`. ~10× faster than WASM on supported devices, but
 *       availability depends on browser (Chromium 113+, Safari Tech Preview) AND hardware. The
 *       runtime surfaces a clean error when WebGPU is unavailable, so the constructor falls back to
 *       WASM automatically.
 *   - WASM (SIMD when available) is the universal fallback. ~2× slower than WebGPU on the same model
 *       but works everywhere onnxruntime-web does — including in Node, which is how the test
 *       harness exercises this file.
 *
 *   Tensor shape + I/O contract matches `ONNXRunner` exactly: the packing and the output decode are
 *   the SAME functions (`ort-feeds.ts`), so the two hosts cannot drift; only the `ort.Tensor`
 *   construction is host-specific.
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

export interface WebONNXRunnerOpts {
	/**
	 * Try the WebGPU execution provider first. Defaults to true. Set false to skip the WebGPU probe — useful in test
	 * environments where WebGPU isn't available and the probe failure adds latency.
	 */
	useWebGPU?: boolean
	/**
	 * Fixed sequence length the model expects. Matches `ONNXRunner.DEFAULT_FIXED_SEQ_LEN` (128) by default. Re-quantized
	 * models can override.
	 */
	fixedSeqLen?: number
	/**
	 * Optional override for where onnxruntime-web should load its `.wasm` assets from. Defaults to the package's CDN
	 * paths; bundlers usually want to point this at a self-hosted copy.
	 *
	 * Example: `setWASMPaths("/static/ort/")` and put the .wasm files at /static/ort/.
	 */
	wasmPathsRoot?: string
}

/**
 * Sequence length the web runtime pads to when the model was exported with a fixed input shape. WebGPU requires static
 * shapes, so a fixed length is the portable default.
 */
export const DEFAULT_FIXED_SEQ_LEN = 128

/**
 * Fetch a URL into bytes, throwing on any non-OK status.
 *
 * Raw `fetch`: this is the BROWSER runtime. `APIClient` carries axios, which has no place in the client bundle, and the
 * platform primitive is what the browser already has.
 */
export async function fetchBytes(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
	const res = await fetchImpl(url)

	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)

	return new Uint8Array(await res.arrayBuffer())
}

/**
 * Apply `wasmPathsRoot` once at module init. Safe to call multiple times.
 */
function configureWASMPaths(root: string | undefined): void {
	if (!root) return
	// onnxruntime-web ships this on `ort.env.wasm`. We assign directly rather than calling
	// `setWASMPaths` so it works across the slightly different shapes the typings have had.
	ort.env.wasm.wasmPaths = root
}

/**
 * The `{data, dims}` view `decodeInferOutput` reads. The float32 dtype is the export contract's, not a runtime check.
 */
function outputTensor(tensor: ort.Tensor): OutputTensor {
	return { data: tensor.data as Float32Array, dims: tensor.dims }
}

export interface WebONNXRunnerDiagnostics {
	backend: "webgpu" | "wasm"
	modelBytes: number
}

export class WebONNXRunner implements NeuralRunner {
	public readonly fixedSeqLen: number
	public diagnostics: WebONNXRunnerDiagnostics | null = null
	#session: ort.InferenceSession | null = null
	#loadPromise: Promise<ort.InferenceSession> | null = null
	private readonly modelBytes: Uint8Array
	private readonly opts: WebONNXRunnerOpts

	private constructor(modelBytes: Uint8Array, opts: WebONNXRunnerOpts) {
		this.modelBytes = modelBytes
		this.opts = opts
		this.fixedSeqLen = opts.fixedSeqLen ?? DEFAULT_FIXED_SEQ_LEN
	}

	/**
	 * Construct from already-fetched model bytes.
	 */
	static async fromBytes(modelBytes: Uint8Array, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		configureWASMPaths(opts.wasmPathsRoot)
		const runner = new WebONNXRunner(modelBytes, opts)

		return runner
	}

	/**
	 * Fetch the model from a URL and construct.
	 */
	static async fromURL(modelURL: string, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		return WebONNXRunner.fromBytes(await fetchBytes(modelURL), opts)
	}

	async #ensureSession(): Promise<ort.InferenceSession> {
		if (this.#session) return this.#session

		if (!this.#loadPromise) {
			this.#loadPromise = (async () => {
				const wantWebGPU = this.opts.useWebGPU !== false

				if (wantWebGPU) {
					try {
						const session = await ort.InferenceSession.create(this.modelBytes, {
							executionProviders: ["webgpu", "wasm"],
							graphOptimizationLevel: "all",
						})

						this.#session = session
						this.diagnostics = { backend: "webgpu", modelBytes: this.modelBytes.byteLength }

						return session
					} catch {
						// WebGPU probe failed — fall through to WASM
					}
				}

				const session = await ort.InferenceSession.create(this.modelBytes, {
					executionProviders: ["wasm"],
					graphOptimizationLevel: "all",
				})

				this.#session = session
				this.diagnostics = { backend: "wasm", modelBytes: this.modelBytes.byteLength }

				return session
			})()
		}

		return this.#loadPromise
	}

	/**
	 * Names of the inputs the loaded ONNX graph declares. `null` until the session has been created (first `infer()`
	 * call). Lets callers (e.g. the neural-web loader) detect anchor/gazetteer-trained models and warn loudly when the
	 * corresponding feature source wasn't provided — running such a model on the zero-filled fallback is the measured
	 * train/inference mismatch ("the zero-fill trap"), not a quality-neutral degrade.
	 */
	get inputNames(): readonly string[] | null {
		return this.#session?.inputNames ?? null
	}

	/**
	 * Mirror of the node `ONNXRunner.inferChars` — the char-path graph, no soft-feed channels (#2164).
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
	 * Mirror of the node `ONNXRunner.infer` — see {@link InferFunction}. Every soft-feed channel is present-conditional on
	 * the graph's declared inputs, with the zero-fill confidence=0 identity for a declared-but-unsupplied channel, so the
	 * session never throws on a missing required input (`packSoftChannelFeeds`).
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
