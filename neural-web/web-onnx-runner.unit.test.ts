/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `WebOnnxRunner`'s feed construction against a MOCKED onnxruntime-web session — no
 *   model files required, so these run in CI where the weights aren't linked.
 *
 *   What this suite guards (the live-demo regression of 2026-06-10): models since v4.2.0 are
 *   gazetteer-anchor-trained and their ONNX graphs declare `gazetteer_features` /
 *   `gazetteer_confidence` (and `anchor_features` / `anchor_confidence`) as REQUIRED inputs. The
 *   runner must mirror `@mailwoman/neural`'s node `OnnxRunner`:
 *
 *   - Caller-provided anchor/gazetteer features are fed through.
 *   - When the graph declares the inputs but the caller provides nothing, zero-fill them (the
 *       confidence=0 identity) instead of letting ORT throw `input 'gazetteer_features' is missing
 *       in 'feeds'`. Zero-fill is a STRUCTURAL fallback only — the loader warns loudly about the
 *       quality trap — but the session must not crash.
 *   - The optional `locale_logits` output (v4.3.0+ locale head) surfaces as `localeLogits`.
 */

import { ANCHOR_FEATURE_DIM, GAZETTEER_FEATURE_DIM } from "@mailwoman/neural/browser"
import { beforeEach, describe, expect, test, vi } from "vitest"

const { sessionCreateMock } = vi.hoisted(() => ({ sessionCreateMock: vi.fn() }))

vi.mock("onnxruntime-web/webgpu", () => {
	/** Captures constructor args so tests can assert on what the runner fed. */
	class Tensor {
		constructor(
			public readonly type: string,
			public readonly data: BigInt64Array | Float32Array,
			public readonly dims: readonly number[]
		) {}
	}

	return {
		Tensor,
		InferenceSession: { create: sessionCreateMock },
		env: { wasm: {} },
	}
})

// Import AFTER the mock declaration (vi.mock is hoisted, but keep the reading order honest).
const { WebOnnxRunner } = await import("./web-onnx-runner.js")

interface FedTensor {
	type: string
	data: BigInt64Array | Float32Array
	dims: readonly number[]
}

const SEQ = 128

function mockSession(inputNames: string[], opts: { localeLogits?: number[]; numLabels?: number } = {}) {
	const numLabels = opts.numLabels ?? 3
	const runCalls: Array<Record<string, FedTensor>> = []
	const session = {
		inputNames,
		runCalls,
		run: vi.fn((feeds: Record<string, FedTensor>) => {
			runCalls.push(feeds)
			const output: Record<string, { data: Float32Array; dims: number[] }> = {
				logits: { data: new Float32Array(SEQ * numLabels), dims: [1, SEQ, numLabels] },
			}

			if (opts.localeLogits) {
				output.locale_logits = {
					data: new Float32Array(opts.localeLogits),
					dims: [1, opts.localeLogits.length],
				}
			}

			return Promise.resolve(output)
		}),
	}
	sessionCreateMock.mockResolvedValue(session)

	return session
}

beforeEach(() => {
	sessionCreateMock.mockReset()
})

describe("WebOnnxRunner feed construction (mocked session)", () => {
	test("gazetteer/anchor-trained graph + NO features provided → zero-filled structural fallback, not a throw", async () => {
		const session = mockSession([
			"input_ids",
			"attention_mask",
			"anchor_features",
			"anchor_confidence",
			"gazetteer_features",
			"gazetteer_confidence",
		])
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })

		// Pre-fix this rejected with ORT's `input 'gazetteer_features' is missing in 'feeds'`.
		const result = await runner.infer([5, 6, 7])
		expect(result.logits.length).toBe(3)

		const feeds = session.runCalls[0]!
		expect(Object.keys(feeds).sort()).toEqual([
			"anchor_confidence",
			"anchor_features",
			"attention_mask",
			"gazetteer_confidence",
			"gazetteer_features",
			"input_ids",
		])
		expect(feeds.gazetteer_features!.dims).toEqual([1, SEQ, GAZETTEER_FEATURE_DIM])
		expect(feeds.gazetteer_confidence!.dims).toEqual([1, SEQ])
		expect(feeds.anchor_features!.dims).toEqual([1, SEQ, ANCHOR_FEATURE_DIM])
		// All-zero = the confidence=0 identity (the model's channel-off behavior).
		expect((feeds.gazetteer_features!.data as Float32Array).every((v) => v === 0)).toBe(true)
		expect((feeds.gazetteer_confidence!.data as Float32Array).every((v) => v === 0)).toBe(true)
		expect((feeds.anchor_features!.data as Float32Array).every((v) => v === 0)).toBe(true)
	})

	test("caller-provided gazetteer + anchor features are fed through verbatim", async () => {
		const session = mockSession([
			"input_ids",
			"attention_mask",
			"anchor_features",
			"anchor_confidence",
			"gazetteer_features",
			"gazetteer_confidence",
		])
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })

		const gazRow = [1, 0, 1, 0, 0] // country + po_box bits, lexicon featureDim = 5
		const anchorRow = Array.from({ length: ANCHOR_FEATURE_DIM }, (_, i) => (i === 0 ? 0.9 : 0))
		await runner.infer(
			[5, 6],
			{ features: [anchorRow, anchorRow.map(() => 0)], confidence: [0.9, 0] },
			{ features: [gazRow, gazRow.map(() => 0)], confidence: [1, 0] }
		)

		const feeds = session.runCalls[0]!
		const gf = feeds.gazetteer_features!.data as Float32Array
		expect(Array.from(gf.subarray(0, GAZETTEER_FEATURE_DIM))).toEqual(gazRow)
		expect(Array.from(gf.subarray(GAZETTEER_FEATURE_DIM, 2 * GAZETTEER_FEATURE_DIM))).toEqual([0, 0, 0, 0, 0])
		const gc = feeds.gazetteer_confidence!.data as Float32Array
		expect(gc[0]).toBe(1)
		expect(gc[1]).toBe(0)

		const af = feeds.anchor_features!.data as Float32Array
		expect(af[0]).toBeCloseTo(0.9)
		const ac = feeds.anchor_confidence!.data as Float32Array
		expect(ac[0]).toBeCloseTo(0.9)
	})

	test("plain graph (no gazetteer inputs) + gazetteer features provided → clue is NOT fed", async () => {
		// Mirrors the node OnnxRunner's `gazetteer && session.inputNames.includes(...)` guard:
		// feeding an undeclared input would itself crash ORT.
		const session = mockSession(["input_ids", "attention_mask"])
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })

		await runner.infer([5], undefined, { features: [[1, 0, 0, 0, 0]], confidence: [1] })

		const feeds = session.runCalls[0]!
		expect(Object.keys(feeds).sort()).toEqual(["attention_mask", "input_ids"])
	})

	test("locale_logits output surfaces as `localeLogits` when the graph exports it", async () => {
		mockSession(["input_ids", "attention_mask"], { localeLogits: [0.25, 0.5, 0.125, 0.125] })
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })

		const result = await runner.infer([5, 6])
		expect(result.localeLogits).toEqual([0.25, 0.5, 0.125, 0.125])
	})

	test("localeLogits is absent (undefined) on graphs without the locale head", async () => {
		mockSession(["input_ids", "attention_mask"])
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })

		const result = await runner.infer([5])
		expect(result.localeLogits).toBeUndefined()
	})

	test("inputNames is null before the session exists and populated after", async () => {
		mockSession(["input_ids", "attention_mask", "gazetteer_features", "gazetteer_confidence"])
		const runner = await WebOnnxRunner.fromBytes(new Uint8Array([1]), { useWebGpu: false })
		expect(runner.inputNames).toBeNull()
		await runner.infer([5])
		expect(runner.inputNames).toContain("gazetteer_features")
	})
})

describe("defaultGazetteerLexiconUrl", () => {
	test("derives the sibling anchor-lexicon-v1.json beside the model URL", async () => {
		const { defaultGazetteerLexiconUrl } = await import("./loader.js")
		expect(defaultGazetteerLexiconUrl("https://public.sister.software/mailwoman/en-us/v4.4.0/model.onnx")).toBe(
			"https://public.sister.software/mailwoman/en-us/v4.4.0/anchor-lexicon-v1.json"
		)
		// Relative URLs stay relative.
		expect(defaultGazetteerLexiconUrl("/static/mailwoman/model.onnx")).toBe("/static/mailwoman/anchor-lexicon-v1.json")
	})
})
