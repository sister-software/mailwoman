/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The web loader's postcode-prefix leg: a listed index becomes the anchor-region lookup, and a
 *   missing or corrupt one is skipped with a warning while the classifier still loads.
 */

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const { sessionCreateMock } = vi.hoisted(() => ({ sessionCreateMock: vi.fn() }))

vi.mock("onnxruntime-web/wasm", () => {
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

vi.mock("#tokenizer", async (importOriginal) => ({
	...(await importOriginal<typeof import("#tokenizer")>()),
	MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
}))

vi.mock("#classifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("#classifier")>()),
	NeuralAddressClassifier: class {},
}))

vi.resetModules()

afterAll(() => vi.resetModules())

const { serializePostcodePrefixIndex } = await import("#postcode/prefix-index")
const { loadNeuralClassifierFromURLs } = await import("#web/loader")

const SEQ = 128

function installMockSession(): void {
	sessionCreateMock.mockReset()

	sessionCreateMock.mockResolvedValue({
		inputNames: ["input_ids", "attention_mask"],
		run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(SEQ * 3), dims: [1, SEQ, 3] } })),
	})
}

const MODEL_URL = "https://cdn.example/mailwoman/v10/model.onnx"
const TOKENIZER_URL = "https://cdn.example/mailwoman/v10/tokenizer.model"
const US_INDEX = "https://cdn.example/mailwoman/v10/postcode-prefix-us.bin"

const US = { placetype: "country", wofID: 85_633_793, name: "United States" }
const VERMONT = { placetype: "region", wofID: 85_688_763, name: "Vermont" }

function usIndexBytes(): Uint8Array {
	return new Uint8Array(
		serializePostcodePrefixIndex(
			{
				country: "us",
				scope: "us",
				schemaVersion: 1,
				levels: ["3"],
				source: "test",
				sourceMD5s: [],
				buildDate: "2026-10-15",
				tier: "shipped",
				attribution: "test",
				coverageNote: "test",
			},
			[{ prefix: "054", ancestors: [US, VERMONT], lat: 44.6, lon: -73, radiusP95Km: 51.6, unitCount: 60 }]
		)
	)
}

function makeFetch(respond: (url: string) => Uint8Array | number): typeof fetch {
	return async (input) => {
		const url = String(input)
		const response = respond(url)

		if (typeof response === "number") {
			return new Response(null, { status: response, statusText: response === 404 ? "Not Found" : "Server Error" })
		}

		return new Response(response.slice().buffer)
	}
}

function baseOpts(fetchImpl: typeof fetch, postcodePrefixURLs: readonly string[]) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		gazetteerLexicon: "none" as const,
		countryLexicon: "none" as const,
		streetTypeLexicon: "none" as const,
		localitySurfaceLexicon: "none" as const,
		pairIndexURLs: [],
		postcodeBinaryURLs: [],
		postcodePrefixURLs,
		fetchImpl,
	}
}

const dummyBytes = new Uint8Array([1, 2, 3])

beforeEach(() => {
	installMockSession()
})

describe("loadNeuralClassifierFromURLs — postcode-prefix index", () => {
	test("a listed index becomes the anchor-region lookup that answers a ZIP's region", async () => {
		const fetchImpl = makeFetch((url) => (url.includes("postcode-prefix-us") ? usIndexBytes() : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [US_INDEX]))

		expect(result.anchorRegions).toBeDefined()
		expect(result.anchorRegions!.ancestorsFor("05448", "US")).toEqual([US, VERMONT])
		expect(result.anchorRegions!.ancestorsFor("20500", "US")).toEqual([])
	})

	test("a 404 index is skipped with a warning and the classifier loads without the lookup", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch((url) => (url.includes("postcode-prefix") ? 404 : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [US_INDEX]))

		expect(result.classifier).toBeDefined()
		expect(result.anchorRegions).toBeUndefined()
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(US_INDEX)

		warn.mockRestore()
	})

	test("no listed index loads no lookup", async () => {
		const result = await loadNeuralClassifierFromURLs(
			baseOpts(
				makeFetch(() => dummyBytes),
				[]
			)
		)

		expect(result.anchorRegions).toBeUndefined()
	})
})
