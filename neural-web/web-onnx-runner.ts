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
 *   Tensor shape + I/O contract matches `ONNXRunner` exactly: fixed-length int64 inputs, padded with
 *   zeros + attention_mask, output is a `logits` tensor of shape `[batch, seq, num_labels]`. See
 *   `@mailwoman/neural/onnx-runner` for the full export contract this file mirrors.
 */

import {
	ANCHOR_FEATURE_DIM,
	COUNTRY_FEATURE_DIM,
	GAZETTEER_FEATURE_DIM,
	type InferResult,
	type NeuralRunner,
} from "@mailwoman/neural/browser"
import * as ort from "onnxruntime-web/webgpu"

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

export const DEFAULT_FIXED_SEQ_LEN = 128

/** Apply `wasmPathsRoot` once at module init. Safe to call multiple times. */
function configureWASMPaths(root: string | undefined): void {
	if (!root) return
	// onnxruntime-web ships this on `ort.env.wasm`. We assign directly rather than calling
	// `setWASMPaths` so it works across the slightly different shapes the typings have had.
	ort.env.wasm.wasmPaths = root
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

	/** Construct from already-fetched model bytes. */
	static async fromBytes(modelBytes: Uint8Array, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		configureWASMPaths(opts.wasmPathsRoot)
		const runner = new WebONNXRunner(modelBytes, opts)

		return runner
	}

	/** Fetch the model from a URL and construct. */
	static async fromURL(modelURL: string, opts: WebONNXRunnerOpts = {}): Promise<WebONNXRunner> {
		const res = await fetch(modelURL)

		if (!res.ok) throw new Error(`fetch ${modelURL} failed: ${res.status} ${res.statusText}`)
		const bytes = new Uint8Array(await res.arrayBuffer())

		return WebONNXRunner.fromBytes(bytes, opts)
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

	async infer(
		tokenIds: number[],
		anchor?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		gazetteer?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		country?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
	): Promise<InferResult> {
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

		// Anchor channel (#239/#240) — mirror of the node ONNXRunner. Feed the per-piece anchor when the
		// caller supplies it; otherwise, for anchor-trained models (whose ONNX declares the inputs as
		// mandatory), feed zeros — the confidence=0 identity / anchor-off path. Without this the session
		// throws on the missing required inputs.
		if (anchor) {
			const dim = anchor.features[0]?.length ?? 0
			const af = new Float32Array(this.fixedSeqLen * dim)
			const ac = new Float32Array(this.fixedSeqLen)

			for (let i = 0; i < seqLen; i++) {
				ac[i] = anchor.confidence[i] ?? 0
				const row = anchor.features[i]

				if (row) {
					for (let d = 0; d < dim; d++) {
						af[i * dim + d] = row[d] ?? 0
					}
				}
			}
			feeds.anchor_features = new ort.Tensor("float32", af, [1, this.fixedSeqLen, dim])
			feeds.anchor_confidence = new ort.Tensor("float32", ac, [1, this.fixedSeqLen])
		} else if (session.inputNames.includes("anchor_features")) {
			feeds.anchor_features = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen * ANCHOR_FEATURE_DIM), [
				1,
				this.fixedSeqLen,
				ANCHOR_FEATURE_DIM,
			])
			feeds.anchor_confidence = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen), [1, this.fixedSeqLen])
		}

		// Gazetteer-anchor channel (#464) — mirror of the node ONNXRunner. Feed the per-piece clue when
		// the caller supplies it AND the graph declares the inputs; for gazetteer-trained models with no
		// clue data, feed zeros (the confidence=0 identity — a structural fallback only; see the loader's
		// loud warning) so the session doesn't throw `input 'gazetteer_features' is missing in 'feeds'`.
		if (gazetteer && session.inputNames.includes("gazetteer_features")) {
			const dim = gazetteer.features[0]?.length ?? 0
			const gf = new Float32Array(this.fixedSeqLen * dim)
			const gc = new Float32Array(this.fixedSeqLen)

			for (let i = 0; i < seqLen; i++) {
				gc[i] = gazetteer.confidence[i] ?? 0
				const row = gazetteer.features[i]

				if (row) {
					for (let d = 0; d < dim; d++) {
						gf[i * dim + d] = row[d] ?? 0
					}
				}
			}
			feeds.gazetteer_features = new ort.Tensor("float32", gf, [1, this.fixedSeqLen, dim])
			feeds.gazetteer_confidence = new ort.Tensor("float32", gc, [1, this.fixedSeqLen])
		} else if (session.inputNames.includes("gazetteer_features")) {
			feeds.gazetteer_features = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen * GAZETTEER_FEATURE_DIM), [
				1,
				this.fixedSeqLen,
				GAZETTEER_FEATURE_DIM,
			])
			feeds.gazetteer_confidence = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen), [1, this.fixedSeqLen])
		}

		// Country-lexicon channel (#1104) — mirror of the node ONNXRunner + the gazetteer branch above.
		// Feed the per-piece country-surface clue when supplied AND the graph declares the inputs; for
		// country-trained models (v6.2.0+) with no lexicon, feed zeros (confidence=0 identity) so the
		// session doesn't throw `input 'country_features' is missing in 'feeds'` — the loader warns loudly.
		if (country && session.inputNames.includes("country_features")) {
			const dim = country.features[0]?.length ?? 0
			const cf = new Float32Array(this.fixedSeqLen * dim)
			const cc = new Float32Array(this.fixedSeqLen)

			for (let i = 0; i < seqLen; i++) {
				cc[i] = country.confidence[i] ?? 0
				const row = country.features[i]

				if (row) {
					for (let d = 0; d < dim; d++) {
						cf[i * dim + d] = row[d] ?? 0
					}
				}
			}
			feeds.country_features = new ort.Tensor("float32", cf, [1, this.fixedSeqLen, dim])
			feeds.country_confidence = new ort.Tensor("float32", cc, [1, this.fixedSeqLen])
		} else if (session.inputNames.includes("country_features")) {
			feeds.country_features = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen * COUNTRY_FEATURE_DIM), [
				1,
				this.fixedSeqLen,
				COUNTRY_FEATURE_DIM,
			])
			feeds.country_confidence = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen), [1, this.fixedSeqLen])
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

			for (let l = 0; l < numLabels; l++) {
				row[l] = data[base + l]!
			}
			logits.push(row)
		}

		// Locale head (#511 Tier A): present on v1.1.0+ exports (shipped v4.3.0+), absent before.
		// Mirrors the node ONNXRunner — `addressSystemConventions: "auto"` depends on this surfacing.
		const localeTensor = output["locale_logits"]
		const localeLogits = localeTensor ? Array.from(localeTensor.data as Float32Array) : undefined

		// Span head (#727 stage-2): present on v3.x+ exports. Same optional contract as the locale head
		// — a pre-v3 bundle has no `span_scores` output and this stays undefined, so the browser's BIO
		// path is byte-unaffected. Mirrors the node ONNXRunner's read exactly (one decoder, two hosts:
		// `neural/semi-markov-decode.ts` is pure TS with no ORT dependency and serves both).
		const spanTensor = output["span_scores"]
		let spanScores: number[][][] | undefined
		let maxSpan: number | undefined

		if (spanTensor) {
			const spanData = spanTensor.data as Float32Array
			const [, , spanLen, numTypes] = spanTensor.dims as readonly [number, number, number, number]
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
}
