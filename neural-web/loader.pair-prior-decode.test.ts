/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end decode proof for the #1278 browser pair-prior wiring: a loader-built classifier (REAL
 *   `NeuralAddressClassifier` + REAL fixture tokenizer, only onnxruntime-web mocked) must thread a
 *   country-matched index's emission matrix AND its TRANSITION-BETA adjustments into the shared decode
 *   (`buildPlacetypePairPriors` → `viterbi` — the same one-decoder-two-hosts path the node classifier
 *   runs), and must be BYTE-STABLE when no index matches the gate.
 *
 *   The fixture is `neural/test/placetype-pair-decode.test.ts`'s task-8 path-fusion lattice on the same
 *   fixture tokenizer: "Shoreditch London" → ['▁Shore','d','itch','▁London'], with a fused street run
 *   (8+7+7=22) that outscores the δ=6-biased dependent_locality reading (6+6+6=18) by 4 — MORE than the
 *   per-piece emission gap, LESS than β=5. So the flip to dependent_locality REQUIRES both halves to
 *   reach viterbi: without the emission matrix the dep-loc path scores ~β alone; without the transition
 *   bonus the fused street path survives (the measured emission-only miss). One assertion, both wires.
 */

import { readFileSync } from "node:fs"

import { repoRootPath } from "@mailwoman/core/utils"
import { serializePairIndex, STAGE2_BIO_LABELS, type PairIndexHeader } from "@mailwoman/neural/browser"
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

// Import AFTER the ORT mock. `@mailwoman/neural/browser` is NOT mocked here — the load runs the real
// tokenizer + classifier so the parse below exercises the real shared decode.
const { loadNeuralClassifierFromURLs } = await import("./loader.ts")

const SEQ = 128
const L = STAGE2_BIO_LABELS.length
const TOKENIZER_FIXTURE = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const MODEL_URL = "https://cdn.example/mailwoman/v10/model.onnx"
const TOKENIZER_URL = "https://cdn.example/mailwoman/v10/tokenizer.model"
const GB_INDEX = "https://cdn.example/mailwoman/v10/pair-index-gb.bin"

function col(label: string): number {
	const idx = STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])

	if (idx < 0) throw new Error(`fixture label ${label} missing from STAGE2_BIO_LABELS`)

	return idx
}

/**
 * The task-8 path-fusion lattice as a canned [1, SEQ, L] logits tensor: rows 0-2 are "shoreditch"'s fused street run,
 * row 3 is a decisive "london" locality. Rows past the real pieces stay zero (the runner slices to seqLen, and the
 * loader's warmup `infer([0])` reads only row 0 — harmless).
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

/** Real PIX1 bytes at the neural fixture's calibration: δ=6, β=5 — the flip needs both (see file header). */
function gbIndexBytes(): Uint8Array {
	const header: PairIndexHeader = {
		country: "gb",
		delta: 6,
		schemaVersion: 1,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
		transitionBeta: 5,
	}

	return serializePairIndex(header, [{ child: "shoreditch", parent: "london", tag: "dependent_locality" }])
}

function makeFetch(): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input)

		if (url === TOKENIZER_URL) return new Response(new Uint8Array(readFileSync(TOKENIZER_FIXTURE)))

		if (url === GB_INDEX) return new Response(gbIndexBytes())

		return new Response(new Uint8Array([1, 2, 3])) // model bytes — the ORT session is mocked
	}) as unknown as typeof fetch
}

function baseOpts(pairIndexURLs: readonly string[], country?: string) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		gazetteerLexiconURL: null,
		countryLexiconURL: null,
		pairIndexURLs,
		...(country !== undefined ? { country } : {}),
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

		// δ=6 emissions alone lose by 4; β=5 alone recovers nothing without the emission mass. The flip is
		// the proof both halves were threaded into the ONE shared decode. Here the prior comes from the
		// config-default posture pin ('en-gb'); the per-parse path is proven in the next test.
		expect(json.dependent_locality).toBe("Shoreditch")
		expect(json.locality).toBe("London")
	})

	test("PER-PARSE selection reaches decode: a selected resolver fed as ParseOpts.placetypePair flips the SAME lattice", async () => {
		// Load with NO country posture → NO config default. The prior can ONLY come from the per-parse
		// selection, so the flip below is proof the selected resolver threads through the shared decode.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = await loadNeuralClassifierFromURLs(baseOpts([GB_INDEX]))
		warn.mockRestore()

		expect(result.pairIndexes).toHaveLength(1)
		expect(result.pairIndexes[0]!.resolver).not.toBeNull() // LIVE despite no posture (phase 2 load-all)

		// "Shoreditch London" has no postcode, so detection alone yields `us` (no bias); the `{ country }`
		// override is the seam a preset uses to pin a posture the text shape can't reveal. The returned opt is
		// spread as ParseOpts.placetypePair — exactly the demo's intended call site.
		const placetypePair = result.selectPairIndexForText("Shoreditch London", { country: "en-gb" })
		expect(placetypePair).toBeDefined()

		const json = await result.classifier.parseJSON("Shoreditch London", { spanProposer: false, placetypePair })
		expect(json.dependent_locality).toBe("Shoreditch")
		expect(json.locality).toBe("London")
	})

	test("BYTE-STABILITY: a LIVE-but-unselected index (no posture, detection yields no match) decodes identically to no index at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const loaded = await loadNeuralClassifierFromURLs(baseOpts([GB_INDEX])) // no country → no config default
		warn.mockRestore()

		fusedLatticeSession() // fresh canned session for the second load
		const priorFree = await loadNeuralClassifierFromURLs(baseOpts([]))

		// Phase 2: the gb index is LIVE + retained (not gated to null), but no posture pin + a text that
		// detects `us` (no UK postcode) means nothing selects it — byte-stable.
		expect(loaded.pairIndexes).toHaveLength(1)
		expect(loaded.pairIndexes[0]!.resolver).not.toBeNull()
		expect(priorFree.pairIndexes).toEqual([])

		// The per-parse selection returns undefined for this US-detecting text (gb-only load) → no prior.
		const placetypePair = loaded.selectPairIndexForText("Shoreditch London")
		expect(placetypePair).toBeUndefined()

		const loadedJSON = await loaded.classifier.parseJSON("Shoreditch London", { spanProposer: false, placetypePair })
		const priorFreeJSON = await priorFree.classifier.parseJSON("Shoreditch London", { spanProposer: false })

		// The unselected load keeps the encoder's fused street reading — and matches the index-free parse exactly.
		expect(loadedJSON).toEqual(priorFreeJSON)
		expect(loadedJSON.street).toBe("Shoreditch")
		expect(loadedJSON.locality).toBe("London")
	})
})
