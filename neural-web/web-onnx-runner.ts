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
 *   - Try WebGPU first when `useWebGpu !== false`. ~10× faster than WASM on supported devices, but
 *       availability depends on browser (Chromium 113+, Safari Tech Preview) AND hardware. The
 *       runtime surfaces a clean error when WebGPU is unavailable, so the constructor falls back to
 *       WASM automatically.
 *   - WASM (SIMD when available) is the universal fallback. ~2× slower than WebGPU on the same model
 *       but works everywhere onnxruntime-web does — including in Node, which is how the test
 *       harness exercises this file.
 *
 *   Tensor shape + I/O contract matches `OnnxRunner` exactly: fixed-length int64 inputs, padded with
 *   zeros + attention_mask, output is a `logits` tensor of shape `[batch, seq, num_labels]`. See
 *   `@mailwoman/neural/onnx-runner` for the full export contract this file mirrors.
 */

import type { InferResult, NeuralRunner } from "@mailwoman/neural/browser"
import * as ort from "onnxruntime-web/webgpu"

export interface WebOnnxRunnerOpts {
	/**
	 * Try the WebGPU execution provider first. Defaults to true. Set false to skip the WebGPU probe —
	 * useful in test environments where WebGPU isn't available and the probe failure adds latency.
	 */
	useWebGpu?: boolean
	/**
	 * Fixed sequence length the model expects. Matches `OnnxRunner.DEFAULT_FIXED_SEQ_LEN` (128) by
	 * default. Re-quantized models can override.
	 */
	fixedSeqLen?: number
	/**
	 * Optional override for where onnxruntime-web should load its `.wasm` assets from. Defaults to
	 * the package's CDN paths; bundlers usually want to point this at a self-hosted copy.
	 *
	 * Example: `setWasmPaths("/static/ort/")` and put the .wasm files at /static/ort/.
	 */
	wasmPathsRoot?: string
}

export const DEFAULT_FIXED_SEQ_LEN = 128

/** Apply `wasmPathsRoot` once at module init. Safe to call multiple times. */
function configureWasmPaths(root: string | undefined): void {
	if (!root) return
	// onnxruntime-web ships this on `ort.env.wasm`. We assign directly rather than calling
	// `setWasmPaths` so it works across the slightly different shapes the typings have had.
	ort.env.wasm.wasmPaths = root
}

export interface WebOnnxRunnerDiagnostics {
	backend: "webgpu" | "wasm"
	modelBytes: number
}

export class WebOnnxRunner implements NeuralRunner {
	public readonly fixedSeqLen: number
	public diagnostics: WebOnnxRunnerDiagnostics | null = null
	#session: ort.InferenceSession | null = null
	#loadPromise: Promise<ort.InferenceSession> | null = null

	private constructor(
		private readonly modelBytes: Uint8Array,
		private readonly opts: WebOnnxRunnerOpts
	) {
		this.fixedSeqLen = opts.fixedSeqLen ?? DEFAULT_FIXED_SEQ_LEN
	}

	/** Construct from already-fetched model bytes. */
	static async fromBytes(modelBytes: Uint8Array, opts: WebOnnxRunnerOpts = {}): Promise<WebOnnxRunner> {
		configureWasmPaths(opts.wasmPathsRoot)
		const runner = new WebOnnxRunner(modelBytes, opts)
		return runner
	}

	/** Fetch the model from a URL and construct. */
	static async fromUrl(modelUrl: string, opts: WebOnnxRunnerOpts = {}): Promise<WebOnnxRunner> {
		const res = await fetch(modelUrl)
		if (!res.ok) throw new Error(`fetch ${modelUrl} failed: ${res.status} ${res.statusText}`)
		const bytes = new Uint8Array(await res.arrayBuffer())
		return WebOnnxRunner.fromBytes(bytes, opts)
	}

	async #ensureSession(): Promise<ort.InferenceSession> {
		if (this.#session) return this.#session
		if (!this.#loadPromise) {
			this.#loadPromise = (async () => {
				const wantWebGpu = this.opts.useWebGpu !== false
				if (wantWebGpu) {
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

	async infer(tokenIds: number[]): Promise<InferResult> {
		const session = await this.#ensureSession()
		const seqLen = Math.min(tokenIds.length, this.fixedSeqLen)
		const padded = new BigInt64Array(this.fixedSeqLen)
		const mask = new BigInt64Array(this.fixedSeqLen)
		for (let i = 0; i < seqLen; i++) {
			padded[i] = BigInt(tokenIds[i]!)
			mask[i] = 1n
		}

		const feeds: Record<string, ort.Tensor> = {
			input_ids: new ort.Tensor("int64", padded, [1, this.fixedSeqLen]),
			attention_mask: new ort.Tensor("int64", mask, [1, this.fixedSeqLen]),
		}

		const output = await session.run(feeds)
		const logitsTensor = output["logits"]
		if (!logitsTensor) throw new Error("ONNX model did not return a `logits` output")
		const data = logitsTensor.data as Float32Array
		const [, , numLabels] = logitsTensor.dims as readonly [number, number, number]

		const logits: number[][] = []
		for (let t = 0; t < seqLen; t++) {
			const row: number[] = new Array(numLabels)
			const base = t * numLabels
			for (let l = 0; l < numLabels; l++) row[l] = data[base + l]!
			logits.push(row)
		}
		return { logits, numLabels }
	}
}
