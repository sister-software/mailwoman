/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Loader wiring for the PIX1 placetype-pair index (#1278 phase 2 — locale-gate wiring): fetch
 *   tolerance, LOAD-ALL construction (every fetched index becomes a live resolver, no load-time gate),
 *   and the OPTIONAL config-default posture pin the `country` load-option now sets.
 *
 *   Strategy mirrors `loader.tolerance.test.ts`: mock onnxruntime-web (no model file) + partial-mock
 *   `@mailwoman/neural/browser` to stub the tokenizer + capture the classifier config, while keeping
 *   the REAL `serializePairIndex` / `PairIndexResolver`, so the fetch-construct path under test runs for
 *   real. The per-parse SELECTION among the loaded indexes lives in `loader.locale-gate.test.ts`
 *   (pure); the decode-level behavior (prior applied on selection, byte-stability without) lives in
 *   `loader.pair-prior-decode.test.ts`, which runs the REAL classifier end-to-end.
 */

import type { PairIndexHeader } from "@mailwoman/neural/browser"
import { beforeEach, describe, expect, test, vi } from "vitest"

const { sessionCreateMock } = vi.hoisted(() => ({ sessionCreateMock: vi.fn() }))

vi.mock("onnxruntime-web/webgpu", () => {
	class Tensor {
		constructor(
			public readonly type: string,
			public readonly data: BigInt64Array | Float32Array,
			public readonly dims: readonly number[]
		) {}
	}

	return { Tensor, InferenceSession: { create: sessionCreateMock }, env: { wasm: {} } }
})

/** The config the (stubbed) `NeuralAddressClassifier` was constructed with — the assertion surface. */
let capturedConfig: {
	placetypePair?: {
		index: { probe(c: string, p: string): string | undefined; delta?: number; transitionBeta?: number }
	}
} | null = null

vi.mock("@mailwoman/neural/browser", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/neural/browser")>()

	return {
		...actual,
		// The real tokenizer needs a valid SentencePiece model; stub the load (we feed dummy bytes).
		MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
		// Capture-only stub: we only care that the load reached construction and WHAT placetypePair config it received.
		NeuralAddressClassifier: class {
			constructor(cfg: NonNullable<typeof capturedConfig>) {
				capturedConfig = cfg
			}
		},
	}
})

// Import AFTER the mock declarations. `serializePairIndex` + `PairIndexResolver` remain REAL (the
// partial mock spreads `actual`), so the binaries built here decode through the real reader.
const { PairIndexResolver, serializePairIndex } = await import("@mailwoman/neural/browser")
const { loadNeuralClassifierFromURLs, resolvePairGateCountry } = await import("./loader.ts")

const SEQ = 128

/** A mocked ORT session with a plain graph (no soft-channel inputs → no unfed-channel warnings). */
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

function pairHeader(country: string, transitionBeta?: number): PairIndexHeader {
	return {
		country,
		delta: 5,
		schemaVersion: 1,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
		...(transitionBeta !== undefined ? { transitionBeta } : {}),
	}
}

/** Real PIX1 bytes: one (shoreditch, london) → dependent_locality entry under the given header. */
function gbIndexBytes(): Uint8Array {
	return serializePairIndex(pairHeader("gb", 5), [{ child: "shoreditch", parent: "london", tag: "dependent_locality" }])
}

function nzIndexBytes(): Uint8Array {
	return serializePairIndex(pairHeader("nz"), [{ child: "mangawhai", parent: "mangawhai", tag: "dependent_locality" }])
}

/**
 * A fake `fetch` whose per-URL response is decided by `respond`. Model/tokenizer URLs get dummy bytes (the ORT session
 * + tokenizer are mocked, so the content is irrelevant).
 */
function makeFetch(respond: (url: string) => Uint8Array | number): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input)
		const outcome = respond(url)

		if (typeof outcome === "number") {
			return new Response(null, { status: outcome, statusText: outcome === 404 ? "Not Found" : "Server Error" })
		}

		return new Response(outcome)
	}) as unknown as typeof fetch
}

function baseOpts(fetchImpl: typeof fetch, pairIndexURLs: readonly string[], country?: string) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		// Skip the sibling-lexicon fetches — irrelevant to the pair-index path under test.
		gazetteerLexiconURL: null,
		countryLexiconURL: null,
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

describe("resolvePairGateCountry", () => {
	test("mirrors the node localeCountry derivation, widened to accept a bare country code", () => {
		expect(resolvePairGateCountry(undefined)).toBe("us") // the node `opts.locale ?? "en-us"` default
		expect(resolvePairGateCountry("en-gb")).toBe("gb")
		expect(resolvePairGateCountry("EN-GB")).toBe("gb")
		expect(resolvePairGateCountry("gb")).toBe("gb")
		expect(resolvePairGateCountry("fr-fr")).toBe("fr")
	})
})

describe("loadNeuralClassifierFromURLs — placetype-pair index (#1278)", () => {
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
		const fetchImpl = makeFetch(() => dummyBytes) // 3 garbage bytes for every URL, the .bin included

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
		// No `country` load-option → no config-default posture pin. The per-parse selection is the only path
		// (byte-stable when nothing selected — asserted end-to-end in loader.pair-prior-decode.test.ts).
		expect(capturedConfig?.placetypePair).toBeUndefined()
		// But the index is LIVE and retained (phase 2: load all, don't gate) — the same instance the per-parse
		// selection can return.
		const [gb] = result.pairIndexes
		expect(result.pairIndexes).toHaveLength(1)
		expect(gb!.url).toBe(GB_INDEX)
		expect(gb!.country).toBe("gb")
		expect(gb!.resolver).toBeInstanceOf(PairIndexResolver)
		expect(gb!.resolver.probe("shoreditch", "london")).toBe("dependent_locality")
		// Omitting the posture is NOT a misconfiguration — no warn (contrast #1300's gate).
		expect(warn).not.toHaveBeenCalled()

		warn.mockRestore()
	})

	test("CONFIG DEFAULT: a gb index under country 'en-gb' becomes the classifier's placetypePair posture pin", async () => {
		const fetchImpl = makeFetch((url) => (url.includes("pair-index-gb") ? gbIndexBytes() : dummyBytes))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "en-gb"))

		const wired = capturedConfig?.placetypePair?.index
		expect(wired).toBeInstanceOf(PairIndexResolver)
		// The node-construction mirror: `{ index }` alone — delta/transitionBeta ride the header via the
		// resolver's getters, probeMode is left to the builder's "auto" default.
		expect(capturedConfig?.placetypePair).toEqual({ index: wired })
		expect(wired!.probe("shoreditch", "london")).toBe("dependent_locality")
		expect(wired!.delta).toBe(5)
		expect(wired!.transitionBeta).toBe(5)

		// The exposed entry carries the SAME resolver instance the classifier got as its default.
		expect(result.pairIndexes).toEqual([{ url: GB_INDEX, country: "gb", resolver: wired }])
	})

	test("a bare country code ('gb') pins the posture too — the browser-side widening", async () => {
		const fetchImpl = makeFetch((url) => (url.includes("pair-index-gb") ? gbIndexBytes() : dummyBytes))

		await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX], "gb"))

		expect(capturedConfig?.placetypePair?.index).toBeInstanceOf(PairIndexResolver)
	})

	test("CONFIG DEFAULT requested but no matching index → warn, no default; the other indexes still load LIVE", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		// Pin 'fr' but only ship gb + nz — the pin can't be honored.
		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX], "fr-fr"))

		// No config default (the pinned country isn't among the loaded ones)…
		expect(capturedConfig?.placetypePair).toBeUndefined()
		// …but both indexes are LIVE for the per-parse path.
		expect(result.pairIndexes.map((i) => i.country)).toEqual(["gb", "nz"])
		expect(result.pairIndexes.every((i) => i.resolver instanceof PairIndexResolver)).toBe(true)
		// The unmet pin is loud and names both sides.
		const warned = warn.mock.calls.map((c) => String(c[0])).join("\n")
		expect(warned).toContain('"fr"')
		expect(warned).toContain('"gb"')

		warn.mockRestore()
	})

	test("multi-locale LOAD-ALL: gb + nz both load LIVE; a 'en-gb' pin makes gb the config default, nz stays available", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX], "en-gb"))

		const wired = capturedConfig?.placetypePair?.index
		expect(wired).toBeInstanceOf(PairIndexResolver)
		// BOTH load live now — nz is no longer gated to null; it is available for a per-parse nz pick.
		const [gb, nz] = result.pairIndexes
		expect(gb).toEqual({ url: GB_INDEX, country: "gb", resolver: wired })
		expect(nz!.country).toBe("nz")
		expect(nz!.resolver).toBeInstanceOf(PairIndexResolver)
		expect(nz!.resolver.probe("mangawhai", "mangawhai")).toBe("dependent_locality")
		// The pin was honored — nothing to warn about.
		expect(warn).not.toHaveBeenCalled()

		warn.mockRestore()
	})

	test("selectPairIndexForText is bound on the LoadResult and picks among the loaded indexes", async () => {
		const fetchImpl = makeFetch((url) =>
			url.includes("pair-index-gb") ? gbIndexBytes() : url.includes("pair-index-nz") ? nzIndexBytes() : dummyBytes
		)

		// No config posture — pure per-parse selection.
		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [GB_INDEX, NZ_INDEX]))
		const gbResolver = result.pairIndexes.find((i) => i.country === "gb")!.resolver

		// A UK-postcode input selects the gb index (the SAME retained instance).
		expect(result.selectPairIndexForText("10 Downing Street, London SW1A 2AA")).toEqual({ index: gbResolver })
		// A US input matches no loaded index → undefined (byte-stable no-prior).
		expect(result.selectPairIndexForText("350 5th Ave, New York, NY 10118")).toBeUndefined()
		// The override pins a posture the text can't reveal.
		expect(result.selectPairIndexForText("Shoreditch London", { country: "en-gb" })).toEqual({ index: gbResolver })
	})

	test("no pairIndexURLs at all → empty exposure, no placetypePair config; selectPairIndexForText yields undefined", async () => {
		const fetchImpl = makeFetch(() => dummyBytes)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, []))

		expect(result.classifier).toBeDefined()
		expect(result.pairIndexes).toEqual([])
		expect(capturedConfig?.placetypePair).toBeUndefined()
		expect(result.selectPairIndexForText("10 Downing Street, London SW1A 2AA")).toBeUndefined()
	})
})
