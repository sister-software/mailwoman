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

import { promises as fs } from "node:fs"
import ort from "onnxruntime-node"

import { ANCHOR_FEATURE_DIM } from "./anchor-inference.js"
import { GAZETTEER_FEATURE_DIM } from "./gazetteer-inference.js"

export interface OnnxRunnerOpts {
	/** If true, load the model immediately in `create()`. Default false. */
	warmup?: boolean
	/**
	 * Fixed sequence length the model expects. v0.1.0 / v0.2.0 quantization baked in 128 (the
	 * training-time max position) even though the fp32 export specified dynamic axes — re-quantize
	 * with a different shape to override. Inputs shorter than this are padded with id `0` and masked
	 * out via attention_mask=0; inputs longer are truncated.
	 */
	fixedSeqLen?: number
}

/** Default sequence length for v0.1.0 / v0.2.0 (BertConfig max_position_embeddings = 128). */
export const DEFAULT_FIXED_SEQ_LEN = 128

export interface InferResult {
	/** Logits per token per label, indexed as `logits[tokenIdx][labelIdx]`. */
	logits: number[][]
	/** Number of label classes (the inner-dim of the logits tensor). */
	numLabels: number
}

export class OnnxRunner {
	private session: ort.InferenceSession | null = null
	private loadPromise: Promise<ort.InferenceSession> | null = null
	public readonly fixedSeqLen: number

	private constructor(
		private readonly modelPath: string,
		private readonly modelBytes: Uint8Array | null,
		opts: OnnxRunnerOpts
	) {
		this.fixedSeqLen = opts.fixedSeqLen ?? DEFAULT_FIXED_SEQ_LEN
	}

	/** Load by path. Reads the model lazily unless `warmup` is true. */
	static async create(modelPath: string, opts: OnnxRunnerOpts = {}): Promise<OnnxRunner> {
		const runner = new OnnxRunner(modelPath, null, opts)
		if (opts.warmup) await runner.ensureSession()
		return runner
	}

	/** Load from an already-read byte buffer. */
	static async fromBytes(modelBytes: Uint8Array, opts: OnnxRunnerOpts = {}): Promise<OnnxRunner> {
		const runner = new OnnxRunner("(bytes)", modelBytes, opts)
		if (opts.warmup) await runner.ensureSession()
		return runner
	}

	private async ensureSession(): Promise<ort.InferenceSession> {
		if (this.session) return this.session
		if (!this.loadPromise) {
			this.loadPromise = (async () => {
				const bytes = this.modelBytes ?? new Uint8Array(await fs.readFile(this.modelPath))
				const session = await ort.InferenceSession.create(bytes, {
					executionProviders: ["cpu"],
					graphOptimizationLevel: "all",
				})
				this.session = session
				return session
			})()
		}
		return this.loadPromise
	}

	/**
	 * Run inference on a single token id sequence.
	 *
	 * Pads to `fixedSeqLen` (default 128) with id 0 + mask 0; truncates if longer. Output is sliced
	 * back to the actual input length.
	 *
	 * @param tokenIds The id sequence produced by the tokenizer (no special tokens added).
	 * @param anchor Optional postcode-anchor channel (#239/#240). When supplied (only for anchor
	 *   models — exported with the `anchor_features`/`anchor_confidence` inputs), per-piece features
	 *   `(seqLen × dim)` + confidence `(seqLen,)` are fed, zero-padded to `fixedSeqLen`. Omit for
	 *   plain models, whose ONNX has no anchor inputs.
	 */
	async infer(
		tokenIds: number[],
		anchor?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> },
		gazetteer?: { features: ReadonlyArray<ReadonlyArray<number>>; confidence: ReadonlyArray<number> }
	): Promise<InferResult> {
		const session = await this.ensureSession()
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

		if (anchor) {
			const dim = anchor.features[0]?.length ?? 0
			const af = new Float32Array(this.fixedSeqLen * dim)
			const ac = new Float32Array(this.fixedSeqLen)
			for (let i = 0; i < seqLen; i++) {
				ac[i] = anchor.confidence[i] ?? 0
				const row = anchor.features[i]
				if (row) for (let d = 0; d < dim; d++) af[i * dim + d] = row[d] ?? 0
			}
			feeds.anchor_features = new ort.Tensor("float32", af, [1, this.fixedSeqLen, dim])
			feeds.anchor_confidence = new ort.Tensor("float32", ac, [1, this.fixedSeqLen])
		} else if (session.inputNames.includes("anchor_features")) {
			// Anchor-trained model (its ONNX declares the anchor inputs as mandatory) but no anchor data
			// was supplied: feed zeros. That's the `confidence = 0` identity — the model's anchor-off
			// behavior. Without it the session throws on the missing required inputs.
			feeds.anchor_features = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen * ANCHOR_FEATURE_DIM), [
				1,
				this.fixedSeqLen,
				ANCHOR_FEATURE_DIM,
			])
			feeds.anchor_confidence = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen), [1, this.fixedSeqLen])
		}

		// Gazetteer-anchor channel (#464): same feed contract as the postcode anchor. Feature width is
		// read from the supplied rows (the lexicon's slot count); a gazetteer-trained model with no clue
		// data supplied gets the confidence=0 identity (the model's gazetteer-off behavior).
		if (gazetteer && session.inputNames.includes("gazetteer_features")) {
			const dim = gazetteer.features[0]?.length ?? 0
			const gf = new Float32Array(this.fixedSeqLen * dim)
			const gc = new Float32Array(this.fixedSeqLen)
			for (let i = 0; i < seqLen; i++) {
				gc[i] = gazetteer.confidence[i] ?? 0
				const row = gazetteer.features[i]
				if (row) for (let d = 0; d < dim; d++) gf[i * dim + d] = row[d] ?? 0
			}
			feeds.gazetteer_features = new ort.Tensor("float32", gf, [1, this.fixedSeqLen, dim])
			feeds.gazetteer_confidence = new ort.Tensor("float32", gc, [1, this.fixedSeqLen])
		} else if (session.inputNames.includes("gazetteer_features")) {
			feeds.gazetteer_features = new ort.Tensor(
				"float32",
				new Float32Array(this.fixedSeqLen * GAZETTEER_FEATURE_DIM),
				[1, this.fixedSeqLen, GAZETTEER_FEATURE_DIM]
			)
			feeds.gazetteer_confidence = new ort.Tensor("float32", new Float32Array(this.fixedSeqLen), [
				1,
				this.fixedSeqLen,
			])
		}

		const output = await session.run(feeds)
		const logitsTensor = output.logits
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
