import type { PairIndexHeaderInput } from "@mailwoman/neural/pair"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const { sessionCreateMock } = vi.hoisted(() => ({ sessionCreateMock: vi.fn() }))

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

let capturedConfig: {
	placetypePair?: {
		index: {
			probe(c: string, p: string): { tag: string; parentTag: string } | undefined
			delta?: number
			transitionBeta?: number
			parentDelta?: number
		}
	}
} | null = null

vi.mock("@mailwoman/neural/tokenizer", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/neural/tokenizer")>()),
	MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
}))

vi.mock("@mailwoman/neural/classifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/neural/classifier")>()),
	NeuralAddressClassifier: class {
		constructor(cfg: NonNullable<typeof capturedConfig>) {
			capturedConfig = cfg
		}
	},
}))

vi.resetModules()
afterAll(() => vi.resetModules())

const { PairIndexResolver, serializePairIndex } = await import("@mailwoman/neural/pair")
const { loadNeuralClassifierFromURLs, resolvePairIndexCountry } = await import("@mailwoman/neural/web-loader")

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
const GB_INDEX = "https://cdn.example/mailwoman/v10/pair-index-gb.bin"
const NZ_INDEX = "https://cdn.example/mailwoman/v10/pair-index-nz.bin"

function pairHeader(country: string, transitionBeta?: number): PairIndexHeaderInput {
	return {
		country,
		delta: 5,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
		...(transitionBeta !== undefined ? { transitionBeta } : {}),
	}
}

function gbIndexBytes(): Uint8Array {
	return serializePairIndex(pairHeader("gb", 5), [
		{ child: "shoreditch", parent: "london", tag: "dependent_locality", parentTag: "locality" },
	])
}

function nzIndexBytes(): Uint8Array {
	return serializePairIndex(pairHeader("nz"), [
		{ child: "mangawhai", parent: "mangawhai", tag: "dependent_locality", parentTag: "locality" },
	])
}

function makeFetch(respond: (url: string) => Uint8Array | number): typeof fetch {
	return async (input) => {
		const url = String(input)
		const outcome = respond(url)

		if (typeof outcome === "number") {
			return new Response(null, { status: outcome, statusText: outcome === 404 ? "Not Found" : "Server Error" })
		}

		return new Response(outcome.slice().buffer)
	}
}

function baseOpts(fetchImpl: typeof fetch, pairIndexURLs: readonly string[], country?: string) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,

		gazetteerLexiconURL: null,
		countryLexiconURL: null,
		streetTypeLexiconURL: null,
		localitySurfaceLexiconURL: null,
		pairIndexURLs,
		...(country !== undefined ? { country } : {}),
		runner: { useWebGPU: false },
		fetchImpl,
	}
}

const dummyBytes = new Uint8Array([1, 2, 3])

beforeEach(() => {
	installMockSession()
	capturedConfig = null
})

describe("resolvePairIndexCountry", () => {
	test("mirrors the node localeCountry derivation, widened to accept a bare country code", () => {
		expect(resolvePairIndexCountry(undefined)).toBe("us")
		expect(resolvePairIndexCountry("en-gb")).toBe("gb")
		expect(resolvePairIndexCountry("EN-GB")).toBe("gb")
		expect(resolvePairIndexCountry("gb")).toBe("gb")
		expect(resolvePairIndexCountry("fr-fr")).toBe("fr")
	})
})

describe("LoadNeuralClassifierFromURLs — placetype-pair index", () => {
	test("a 404 pair index is skipped with a warn; the classifier STILL loads, prior off", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch((url) => (url.includes("pair-index") ? 404 : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "en-gb"))

		expect(result.classifier).toBeDefined()
		expect(capturedConfig?.placetypePair).toBeUndefined()
		expect(result.pairIndexes).toEqual([])

		const warned = warn.mock.calls.map((c) => String(c[0])).join("\n")
		expect(warned).toContain(GB_INDEX)
		expect(warned).toContain("404")

		warn.mockRestore()
	})

	test("a PRESENT-but-corrupt pair index (bad magic) degrades to a skip, not a brick", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch(() => dummyBytes)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "en-gb"))

		expect(result.classifier).toBeDefined()
		expect(capturedConfig?.placetypePair).toBeUndefined()
		expect(result.pairIndexes).toEqual([])
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(GB_INDEX)

		warn.mockRestore()
	})

	test("LOAD-ALL: a gb index with NO country posture loads LIVE, but sets no config default (per-parse mode)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch((url) => (url.includes("pair-index-gb") ? gbIndexBytes() : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX]))

		expect(result.classifier).toBeDefined()

		expect(capturedConfig?.placetypePair).toBeUndefined()

		const [gb] = result.pairIndexes
		expect(result.pairIndexes).toHaveLength(1)
		expect(gb!.url).toBe(GB_INDEX)
		expect(gb!.country).toBe("gb")
		expect(gb!.resolver).toBeInstanceOf(PairIndexResolver)
		expect(gb!.resolver.probe("shoreditch", "london")?.tag).toBe("dependent_locality")

		expect(warn).not.toHaveBeenCalled()

		warn.mockRestore()
	})

	test("CONFIG DEFAULT: a gb index under country 'en-gb' becomes the classifier's placetypePair posture pin", async () => {
		const fetchImpl = makeFetch((url) => (url.includes("pair-index-gb") ? gbIndexBytes() : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "en-gb"))

		const wired = capturedConfig?.placetypePair?.index
		expect(wired).toBeInstanceOf(PairIndexResolver)

		expect(capturedConfig?.placetypePair).toEqual({ index: wired })
		expect(wired!.probe("shoreditch", "london")?.tag).toBe("dependent_locality")
		expect(wired!.delta).toBe(5)
		expect(wired!.transitionBeta).toBe(5)

		expect(result.pairIndexes).toEqual([{ url: GB_INDEX, country: "gb", resolver: wired }])
	})

	test("A bare country code ('gb') pins the posture too — the browser-side widening", async () => {
		const fetchImpl = makeFetch((url) => (url.includes("pair-index-gb") ? gbIndexBytes() : dummyBytes))

		await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "gb"))

		expect(capturedConfig?.placetypePair?.index).toBeInstanceOf(PairIndexResolver)
	})

	test("CONFIG DEFAULT requested but neither matching index → warn nor default; the other indexes still load LIVE", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX], "fr-fr"))

		expect(capturedConfig?.placetypePair).toBeUndefined()

		expect(result.pairIndexes.map((i) => i.country)).toEqual(["gb", "nz"])
		expect(result.pairIndexes.every((i) => i.resolver instanceof PairIndexResolver)).toBe(true)

		const warned = warn.mock.calls.map((c) => String(c[0])).join("\n")
		expect(warned).toContain('"fr"')
		expect(warned).toContain('"gb"')

		warn.mockRestore()
	})

	test("Multi-locale LOAD-ALL: gb + nz both load LIVE; a 'en-gb' pin makes gb the config default, nz stays available", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX], "en-gb"))

		const wired = capturedConfig?.placetypePair?.index
		expect(wired).toBeInstanceOf(PairIndexResolver)

		const [gb, nz] = result.pairIndexes
		expect(gb).toEqual({ url: GB_INDEX, country: "gb", resolver: wired })
		expect(nz!.country).toBe("nz")
		expect(nz!.resolver).toBeInstanceOf(PairIndexResolver)
		expect(nz!.resolver.probe("mangawhai", "mangawhai")?.tag).toBe("dependent_locality")

		expect(warn).not.toHaveBeenCalled()

		warn.mockRestore()
	})

	test("selectPairIndexForText is bound on the LoadResult and picks among the loaded indexes", async () => {
		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX]))
		const gbResolver = result.pairIndexes.find((i) => i.country === "gb")!.resolver

		expect(result.selectPairIndexForText("10 Downing Street, London SW1A 2AA")).toEqual({ index: gbResolver })

		expect(result.selectPairIndexForText("350 5th Ave, New York, NY 10118")).toBeUndefined()

		expect(result.selectPairIndexForText("Shoreditch London", { country: "en-gb" })).toEqual({ index: gbResolver })
	})

	test("Neither pairIndexURLs at all → empty exposure nor placetypePair config; selectPairIndexForText yields undefined", async () => {
		const fetchImpl = makeFetch(() => dummyBytes)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, []))

		expect(result.classifier).toBeDefined()
		expect(result.pairIndexes).toEqual([])
		expect(capturedConfig?.placetypePair).toBeUndefined()
		expect(result.selectPairIndexForText("10 Downing Street, London SW1A 2AA")).toBeUndefined()
	})
})
