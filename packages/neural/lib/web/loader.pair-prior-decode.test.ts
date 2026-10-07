/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A loader-built classifier (real `NeuralAddressClassifier` plus the real fixture tokenizer, only
 *   onnxruntime-web mocked) must thread a country-matched index's emission matrix and its
 *   transition-beta adjustments into the shared decode. It must remain byte-stable when no index matches
 *   the evaluation data.
 *
 *   The fixture is the path-fusion lattice "Shoreditch London" → ['▁Shore','d','itch','▁London']: the
 *   fused street run (8+7+7=22) outscores the δ=6-biased dependent_locality reading (6+6+6=18) by 4,
 *   so the flip requires both the emission matrix and the β=5 transition bonus to reach viterbi.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

import { STAGE2_BIO_LABELS } from "#labels"
import { serializePairIndex, type PairIndexHeaderInput } from "#pair"

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

// Shared-graph guard: the root vitest config runs `isolate: false`, so reset modules on the way in and
// out, or a cached `./loader.ts` evaluates without this file's ORT mock and the next file inherits it.
vi.resetModules()
afterAll(() => vi.resetModules())

// Import after the ORT mock.
// The tokenizer and classifier run real so the parse exercises the shared decode.
const { loadNeuralClassifierFromURLs } = await import("#web/loader")

const SEQ = 128
const L = STAGE2_BIO_LABELS.length
const TOKENIZER_FIXTURE = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const MODEL_URL = "https://cdn.example/mailwoman/v10/model.onnx"
const TOKENIZER_URL = "https://cdn.example/mailwoman/v10/tokenizer.model"
const GB_INDEX = "https://cdn.example/mailwoman/v10/pair-index-gb.bin"

function col(label: string): number {
	const idx = STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])

	if (idx === -1) throw new Error(`fixture label ${label} missing from STAGE2_BIO_LABELS`)

	return idx
}

/**
 * The path-fusion lattice as a canned [1, SEQ, L] logits tensor: rows 0-2 are
 * "shoreditch"'s fused street run, row 3 a decisive "london" locality.
 * Rows past the real pieces stay zero.
 */
function fusedLatticeSession(): void {
	const flat = new Float32Array(SEQ * L)
	flat[col("B-street")] = 8 // piece 0
	flat[L + col("I-street")] = 7 // piece 1
	flat[2 * L + col("I-street")] = 7 // piece 2
	flat[3 * L + col("B-locality")] = 10 // piece 3

	sessionCreateMock.mockReset()

	sessionCreateMock.mockResolvedValue({
		inputNames: ["input_ids", "attention_mask"],
		run: vi.fn(() => Promise.resolve({ logits: { data: flat, dims: [1, SEQ, L] } })),
	})
}

/**
 * Real PIX1 bytes at the neural fixture's calibration: δ=6, β=5.
 */
function gbIndexBytes(): Uint8Array {
	const header: PairIndexHeaderInput = {
		country: "gb",
		delta: 6,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
		transitionBeta: 5,
	}

	return serializePairIndex(header, [
		{ child: "shoreditch", parent: "london", tag: "dependent_locality", parentTag: "locality" },
	])
}

function makeFetch(): typeof fetch {
	return async (input) => {
		const url = String(input)

		if (url === TOKENIZER_URL) return new Response(new Uint8Array(await readLocalBuffer(TOKENIZER_FIXTURE)))

		if (url === GB_INDEX) return new Response(gbIndexBytes().slice().buffer)

		return new Response(new Uint8Array([1, 2, 3])) // model bytes — the ORT session is mocked
	}
}

function baseOpts(pairIndexURLs: readonly string[], country?: string) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		gazetteerLexiconURL: null,
		countryLexiconURL: null,
		streetTypeLexiconURL: null,
		localitySurfaceLexiconURL: null,
		pairIndexURLs,
		...(country ? { country } : {}),
		runner: { useWebGPU: false },
		fetchImpl: makeFetch(),
	}
}

beforeEach(() => {
	fusedLatticeSession()
})

describe("loader-built classifier — pair prior in the shared decode (#1278)", () => {
	test("CONFIG DEFAULT (country pin): emission + transition BOTH reach viterbi — the fused lattice flips to dependent_locality", async () => {
		const { classifier, pairIndexes } = await loadNeuralClassifierFromURLs(baseOpts([GB_INDEX], "en-gb"))

		expect(pairIndexes).toHaveLength(1)
		expect(pairIndexes[0]!.resolver).not.toBeNull()

		const json = await classifier.parseJSON("Shoreditch London", { spanProposer: false })

		expect(json.dependent_locality).toBe("Shoreditch")
		expect(json.locality).toBe("London")
	})

	test("PER-PARSE selection reaches decode: a selected resolver fed as ParseOpts.placetypePair flips the SAME lattice", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = await loadNeuralClassifierFromURLs(baseOpts([GB_INDEX]))
		warn.mockRestore()

		expect(result.pairIndexes).toHaveLength(1)
		expect(result.pairIndexes[0]!.resolver).not.toBeNull() // LIVE despite no posture (phase 2 load-all)

		// "Shoreditch London" has no postcode, so the call site pins the posture with `{ country }`.
		const placetypePair = result.selectPairIndexForText("Shoreditch London", { country: "en-gb" })
		expect(placetypePair).not.toBeNull()

		const json = await result.classifier.parseJSON("Shoreditch London", {
			spanProposer: false,
			placetypePair: placetypePair ?? "inherit",
		})

		expect(json.dependent_locality).toBe("Shoreditch")
		expect(json.locality).toBe("London")
	})

	test("BYTE-STABILITY: a LIVE-but-unselected index (no posture, detection yields no match) decodes identically to no index at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const loaded = await loadNeuralClassifierFromURLs(baseOpts([GB_INDEX])) // no country → no config default
		warn.mockRestore()

		fusedLatticeSession() // fresh canned session for the second load
		const priorFree = await loadNeuralClassifierFromURLs(baseOpts([]))

		expect(loaded.pairIndexes).toHaveLength(1)
		expect(loaded.pairIndexes[0]!.resolver).not.toBeNull()
		expect(priorFree.pairIndexes).toEqual([])

		const placetypePair = loaded.selectPairIndexForText("Shoreditch London")
		expect(placetypePair).toBeNull()

		const loadedJSON = await loaded.classifier.parseJSON("Shoreditch London", {
			spanProposer: false,
			placetypePair: placetypePair ?? "inherit",
		})

		const priorFreeJSON = await priorFree.classifier.parseJSON("Shoreditch London", { spanProposer: false })

		expect(loadedJSON).toEqual(priorFreeJSON)
		expect(loadedJSON.street).toBe("Shoreditch")
		expect(loadedJSON.locality).toBe("London")
	})
})
