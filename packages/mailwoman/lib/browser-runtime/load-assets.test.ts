/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The release loader starts the FST, morphology, calibration and ORT wasm fetches beside the classifier, starts the
 *   card, model, embedding and tokenizer fetches before the loader chunk resolves, and still advances the step labels
 *   in order.
 */

import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const { classifierLoad, fstLoad, morphologyLoad } = vi.hoisted(() => ({
	classifierLoad: vi.fn(),
	fstLoad: vi.fn(),
	morphologyLoad: vi.fn(),
}))

vi.mock("@mailwoman/neural/web/loader", () => ({ loadNeuralClassifierFromURLs: classifierLoad }))

vi.mock("#browser-runtime/resources", async (importOriginal) => ({
	...(await importOriginal<typeof import("#browser-runtime/resources")>()),
	loadFSTGazetteer: fstLoad,
	loadStreetMorphologyFST: morphologyLoad,
}))

// The root vitest config shares one module graph per worker, so the loader is re-evaluated against these mocks.
vi.resetModules()
afterAll(() => vi.resetModules())

const { loadReleaseAssets } = await import("#browser-runtime/load-assets")

const WASM_URL = "https://earth.example/assets/ort-wasm-simd-threaded.wasm"

function makeProgress(events: string[]) {
	return {
		signal: new AbortController().signal,
		setProgress: () => {},
		setStepLabels: (labels: string[]) => events.push(`labels:${labels.join("|")}`),
		setStepIndex: (index: number) => events.push(`step:${index}`),
		setBackend: () => {},
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	classifierLoad.mockReset()
	fstLoad.mockReset()
	morphologyLoad.mockReset()
})

describe("loadReleaseAssets", () => {
	test("the FST, morphology, calibration and wasm fetches start before the classifier resolves", async () => {
		const events: string[] = []
		const requested: string[] = []

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			requested.push(String(input))

			return new Response(null, { status: 404 })
		})

		let resolveClassifier: (value: unknown) => void = () => {}

		classifierLoad.mockImplementation(
			(opts: { runner?: { wasmBinary?: Promise<Uint8Array | null> } }) =>
				new Promise((resolve) => {
					events.push(`classifier:wasm=${opts.runner?.wasmBinary ? "early" : "none"}`)
					resolveClassifier = resolve
				})
		)

		fstLoad.mockImplementation(async () => {
			events.push("fst")

			return { matcher: { fst: true }, provenance: null }
		})

		morphologyLoad.mockImplementation(async () => {
			events.push("morphology")

			return { morphology: true }
		})

		const loading = loadReleaseAssets(
			{ version: "v1", label: "v1", hasFST: true, hasWOFDB: false } as Parameters<typeof loadReleaseAssets>[0],
			makeProgress(events),
			{ ortWASMURL: WASM_URL }
		)

		await vi.waitFor(() => expect(events).toContain("classifier:wasm=early"))
		expect(events).toEqual(expect.arrayContaining(["fst", "morphology"]))
		expect(requested).toContain(WASM_URL)
		expect(requested.some((url) => url.endsWith("calibration.json"))).toBe(true)
		expect(events).not.toContain("step:0")

		resolveClassifier({ classifier: {}, diagnostics: null })

		const assets = await loading

		expect(events.filter((event) => event.startsWith("step:"))).toEqual(["step:0", "step:1", "step:2"])
		expect(assets.fstMatcher).toEqual({ fst: true })
		expect(assets.streetMorphologyMatcher).toEqual({ morphology: true })
		expect(assets.calibrator).toBeNull()
	})

	test("the card, model, embedding and tokenizer fetches start before the loader runs and are handed to it", async () => {
		const requested: string[] = []

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			requested.push(String(input))

			return new Response("{}", { status: 200 })
		})

		let requestedAtLoaderCall: string[] = []

		classifierLoad.mockImplementation(
			async (opts: { modelCardURL: string; modelURL: string; tokenizerURL: string; fetchImpl: typeof fetch }) => {
				requestedAtLoaderCall = [...requested]

				// The loader's own reads take the started responses rather than issuing new requests.
				await opts.fetchImpl(opts.modelCardURL)
				await opts.fetchImpl(opts.modelURL)
				await opts.fetchImpl(opts.tokenizerURL)

				return { classifier: {}, diagnostics: null }
			}
		)

		await loadReleaseAssets(
			{ version: "v1", label: "v1", hasFST: false, hasWOFDB: false, splitEmbeddings: true } as Parameters<
				typeof loadReleaseAssets
			>[0],
			makeProgress([])
		)

		const started = ["model-card.json", "encoder.onnx", "embeddings-hot.bin", "tokenizer.model"]

		for (const name of started) {
			expect(requestedAtLoaderCall.filter((url) => url.endsWith(name))).toHaveLength(1)
			expect(requested.filter((url) => url.endsWith(name))).toHaveLength(1)
		}
	})

	test("a failed prefetched card rejects at the loader's read, not before it", async () => {
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).endsWith("model-card.json")) throw new SyntaxError("card unreadable")

			return new Response(null, { status: 404 })
		})

		classifierLoad.mockImplementation(async (opts: { modelCardURL: string; fetchImpl: typeof fetch }) => {
			await opts.fetchImpl(opts.modelCardURL)

			return { classifier: {}, diagnostics: null }
		})

		await expect(
			loadReleaseAssets(
				{ version: "v1", label: "v1", hasFST: false, hasWOFDB: false } as Parameters<typeof loadReleaseAssets>[0],
				makeProgress([])
			)
		).rejects.toThrow("card unreadable")
	})

	test("the morphology matcher is dropped when the gazetteer FST fails, and the failure is not unhandled", async () => {
		vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }))
		classifierLoad.mockResolvedValue({ classifier: {}, diagnostics: null })
		fstLoad.mockRejectedValue(new Error("FST fetch failed (404)"))
		morphologyLoad.mockResolvedValue({ morphology: true })

		const assets = await loadReleaseAssets(
			{ version: "v1", label: "v1", hasFST: true, hasWOFDB: false } as Parameters<typeof loadReleaseAssets>[0],
			makeProgress([])
		)

		expect(assets.fstMatcher).toBeNull()
		expect(assets.streetMorphologyMatcher).toBeNull()
	})
})
