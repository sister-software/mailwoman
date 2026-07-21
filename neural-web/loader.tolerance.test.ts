/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression test for the 2026-07 demo outage: an OPTIONAL postcode-anchor binary that 404s must
 *   NOT block the whole classifier load.
 *
 *   The incident: `postcode-de.bin` went 404 on prod R2 for every shipped version (postcode-us/fr
 *   stayed 200). The loader fetched the postcode binaries with a throwing `Promise.all(...fetchBytes)`,
 *   so that single 404 rejected the whole `Promise.all` → `loadNeuralClassifierFromURLs` rejected →
 *   the demo's `runtime.ready` never fired → the input stayed permanently disabled even though the
 *   model, tokenizer, and the other postcode binaries were all fine.
 *
 *   The postcode anchor is a SOFT ranking channel, not a load-bearing model input. This suite pins the
 *   fix: one 404 is skipped (with a loud warn) and the classifier still loads with the survivors'
 *   anchors; ALL 404 collapses to the anchor-off identity (undefined lookup) and STILL loads.
 *
 *   Strategy mirrors `web-onnx-runner.unit.test.ts` — mock onnxruntime-web so no real model file is
 *   needed — plus a partial mock of `@mailwoman/neural/browser` that stubs the tokenizer + classifier
 *   (which need a real tokenizer.model) while keeping the REAL `PostcodeBinaryResolver` +
 *   `serializePostcodeBinary`, so the postcode-load-and-merge path under test runs for real.
 */

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
let capturedConfig: { postcodeAnchorLookup?: Map<string, unknown> } | null = null

vi.mock("@mailwoman/neural/browser", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/neural/browser")>()

	return {
		...actual,
		// The real tokenizer needs a valid SentencePiece model; stub the load (we feed dummy bytes).
		MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
		// Capture-only stub: the real classifier needs the real tokenizer + label wiring. We only care
		// that it is CONSTRUCTED (the load reached the end) and WHAT postcode lookup it received.
		NeuralAddressClassifier: class {
			constructor(cfg: { postcodeAnchorLookup?: Map<string, unknown> }) {
				capturedConfig = cfg
			}
		},
	}
})

// Import AFTER the mock declarations. `serializePostcodeBinary` + `PostcodeBinaryResolver` remain REAL
// (the partial mock spreads `actual`), so the binaries we build here decode through the real reader.
const { serializePostcodeBinary } = await import("@mailwoman/neural/browser")
const { loadNeuralClassifierFromURLs } = await import("./loader.ts")

const SEQ = 128

/** A mocked ORT session with a plain graph (no soft-channel inputs → no unfed-channel warnings). */
function installMockSession(): void {
	sessionCreateMock.mockReset()
	sessionCreateMock.mockResolvedValue({
		inputNames: ["input_ids", "attention_mask"],
		run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(SEQ * 3), dims: [1, SEQ, 3] } })),
	})
}

const US_BIN = "https://cdn.example/mailwoman/v9/postcode-us.bin"
const DE_BIN = "https://cdn.example/mailwoman/v9/postcode-de.bin"
const MODEL_URL = "https://cdn.example/mailwoman/v9/model.onnx"
const TOKENIZER_URL = "https://cdn.example/mailwoman/v9/tokenizer.model"

/**
 * A fake `fetch` whose per-URL status is decided by `statusFor`. 200 responses carry real bytes: a decodable
 * single-record postcode binary for the `.bin` URLs, dummy bytes for model/tokenizer (the ORT session + tokenizer are
 * mocked, so the content is irrelevant).
 */
function makeFetch(statusFor: (url: string) => number): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input)
		const status = statusFor(url)

		if (status !== 200) {
			return new Response(null, { status, statusText: status === 404 ? "Not Found" : "Server Error" })
		}

		if (url.includes("postcode-us")) {
			return new Response(serializePostcodeBinary([{ postcode: "10001", country: "US", lat: 40.7478, lon: -73.985 }]))
		}

		if (url.includes("postcode-de")) {
			return new Response(serializePostcodeBinary([{ postcode: "10115", country: "DE", lat: 52.53, lon: 13.38 }]))
		}

		return new Response(new Uint8Array([1, 2, 3])) // model / tokenizer — mocked downstream
	}) as unknown as typeof fetch
}

function baseOpts(fetchImpl: typeof fetch, postcodeBinaryURLs: readonly string[]) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		// Skip the sibling-lexicon fetches — irrelevant to the postcode-tolerance path under test.
		gazetteerLexiconURL: null,
		countryLexiconURL: null,
		postcodeBinaryURLs,
		runner: { useWebGPU: false },
		fetchImpl,
	}
}

beforeEach(() => {
	installMockSession()
	capturedConfig = null
})

describe("loadNeuralClassifierFromURLs — optional postcode-anchor binary tolerance (demo outage #fix)", () => {
	test("ONE 404 postcode binary is skipped with a warn; the classifier STILL loads with the survivor's anchors", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		// postcode-de.bin 404s (the live incident); postcode-us.bin + model + tokenizer are 200.
		const fetchImpl = makeFetch((url) => (url.includes("postcode-de") ? 404 : 200))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [US_BIN, DE_BIN]))

		// ready fires: the load resolved and constructed a classifier.
		expect(result.classifier).toBeDefined()

		// The 200 binary's anchors ARE present; the 404 one is absent.
		const lookup = capturedConfig?.postcodeAnchorLookup
		expect(lookup).toBeInstanceOf(Map)
		expect(lookup!.has("10001")).toBe(true) // US survived
		expect(lookup!.has("10115")).toBe(false) // DE was skipped

		// The skip was loud and named the URL + the status.
		const warned = warn.mock.calls.map((c) => String(c[0])).join("\n")
		expect(warned).toContain(DE_BIN)
		expect(warned).toContain("404")

		warn.mockRestore()
	})

	test("ALL postcode binaries 404 → classifier loads with an UNDEFINED postcode lookup (anchor-off identity)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const fetchImpl = makeFetch((url) => (url.includes("postcode") ? 404 : 200))

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [US_BIN, DE_BIN]))

		// Still loads — identical to the no-postcodes-configured path.
		expect(result.classifier).toBeDefined()
		expect(capturedConfig?.postcodeAnchorLookup).toBeUndefined()

		// Both skips were warned.
		const warned = warn.mock.calls.map((c) => String(c[0])).join("\n")
		expect(warned).toContain(US_BIN)
		expect(warned).toContain(DE_BIN)

		warn.mockRestore()
	})

	test("both binaries 200 → both postcodes' anchors merge in (the happy path is unregressed)", async () => {
		const fetchImpl = makeFetch(() => 200)

		const result = await loadNeuralClassifierFromURLs(baseOpts(fetchImpl, [US_BIN, DE_BIN]))

		expect(result.classifier).toBeDefined()
		const lookup = capturedConfig?.postcodeAnchorLookup
		expect(lookup).toBeInstanceOf(Map)
		expect(lookup!.has("10001")).toBe(true)
		expect(lookup!.has("10115")).toBe(true)
	})
})
