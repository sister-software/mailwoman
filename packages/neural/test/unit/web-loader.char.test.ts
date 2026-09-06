/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The browser loader takes the char path when the card says `encoder: "char"` (#2164): it fetches the graph and
 *   the sealed vocabulary, never the tokenizer or the lexicons, and hands the classifier a `charEncoder`.
 */

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const { sessionCreateMock, classifierConfigs } = vi.hoisted(() => ({
	sessionCreateMock: vi.fn(),
	classifierConfigs: [] as Array<Record<string, unknown>>,
}))

vi.mock("onnxruntime-web/webgpu", () => {
	class Tensor {
		readonly type: string
		readonly data: BigInt64Array | Float32Array
		readonly dims: readonly number[]

		constructor(type: string, data: BigInt64Array | Float32Array, dims: readonly number[]) {
			this.type = type
			this.data = data
			this.dims = dims
		}
	}

	return { Tensor, InferenceSession: { create: sessionCreateMock }, env: { wasm: {} } }
})

vi.mock("@mailwoman/neural/classifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/neural/classifier")>()),
	NeuralAddressClassifier: class {
		constructor(config: Record<string, unknown>) {
			classifierConfigs.push(config)
		}
	},
}))

vi.resetModules()
afterAll(() => vi.resetModules())

const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web-loader")

const BASE = "https://cdn.example/mailwoman/cjk"
const VOCAB = { "<pad>": 0, "<unk>": 1, 京: 2, 東: 3 }

const CARD = {
	encoder: "char",
	char_vocab: "char-vocab.json",
	max_units: 96,
	max_unit_width: 7,
	char_ctx: 3,
	labels: ["O", "B-prefecture", "I-prefecture"],
}

function charFetch(requested: string[]): typeof fetch {
	return async (input) => {
		const url = String(input)
		requested.push(url)

		if (url.endsWith("model-card.json")) {
			return new Response(JSON.stringify(CARD), { headers: { "content-type": "application/json" } })
		}

		if (url.endsWith("char-vocab.json")) {
			return new Response(JSON.stringify(VOCAB), { headers: { "content-type": "application/json" } })
		}

		if (url.endsWith("model.onnx")) return new Response(new Uint8Array([1, 2, 3]))

		return new Response(null, { status: 404, statusText: "Not Found" })
	}
}

describe("the browser loader on a char card", () => {
	beforeEach(() => {
		sessionCreateMock.mockReset()
		classifierConfigs.length = 0

		sessionCreateMock.mockResolvedValue({
			inputNames: ["char_ids", "attention_mask"],
			run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(96 * 3), dims: [1, 96, 3] } })),
		})
	})

	test("fetches the graph and the vocabulary beside it, and nothing SentencePiece", async () => {
		const requested: string[] = []

		const result = await loadNeuralClassifierFromURLs({
			modelURL: `${BASE}/model.onnx`,
			modelCardURL: `${BASE}/model-card.json`,
			fetchImpl: charFetch(requested),
		})

		expect(requested).toContain(`${BASE}/char-vocab.json`)
		expect(requested.some((url) => url.endsWith("tokenizer.model"))).toBe(false)
		expect(requested.some((url) => url.includes("lexicon"))).toBe(false)
		expect(result.labels).toEqual(CARD.labels)

		const config = classifierConfigs[0]!
		const charEncoder = config.charEncoder as { vocabulary: Map<string, number>; contract: Record<string, number> }

		expect(config.tokenizer).toBeUndefined()
		expect(charEncoder.contract).toEqual({ maxUnits: 96, maxUnitWidth: 7, ctxChars: 3 })
		expect(charEncoder.vocabulary.get("東")).toBe(3)
	})

	test("refuses a SentencePiece card with no tokenizerURL rather than loading nothing", async () => {
		const requested: string[] = []

		await expect(
			loadNeuralClassifierFromURLs({
				modelURL: `${BASE}/model.onnx`,
				modelCardURL: `${BASE}/model-card.json`,
				fetchImpl: async (input) => {
					requested.push(String(input))

					return new Response(JSON.stringify({ labels: ["O"] }), { headers: { "content-type": "application/json" } })
				},
			})
		).rejects.toThrow(/tokenizerURL/)
	})
})
