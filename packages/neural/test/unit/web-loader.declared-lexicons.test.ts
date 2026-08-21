/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser loader must resolve evidence-lexicon FILENAMES from the model-card's
 *   `requires.<channel>.lexicon` declarations, exactly as the Node resolver does — the sibling
 *   defaults are a legacy fallback for bundles that predate the declarations, not the contract.
 *
 *   The incident this pins: the en-us bundle moved to `locality-surface-lexicon-v7.json`
 *   (2026-08-05) and the card declared it, but the web loader kept deriving the legacy `-v6`
 *   sibling name. The tolerant fetch turned the 404 into a silently-unfed locality channel — the
 *   demo ran a locality_surface-REQUIRED model with the channel off for six days, the same OOD
 *   class the #718 soft-feed exists to prevent, with no error anywhere.
 *
 *   Mock strategy mirrors `web-loader.tolerance.test.ts`: ORT + tokenizer + classifier stubbed,
 *   fetch recorded per URL, nothing else mocked.
 */

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

vi.mock("../../tokenizer.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/neural/tokenizer")>()),
	MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
}))

vi.mock("../../classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/neural/classifier")>()),
	NeuralAddressClassifier: class {},
}))

vi.resetModules()
afterAll(() => vi.resetModules())

const { loadNeuralClassifierFromURLs } = await import("@mailwoman/neural/web-loader")

const BASE = "https://cdn.example/mailwoman/v9.1.0"

/**
 * Fetch stub: 200 with card JSON at the card URL, 200 dummy bytes everywhere else, and every requested URL recorded —
 * the assertion surface is WHICH names were derived, not what loaded.
 */
function makeRecordingFetch(card: object | null, requested: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input)
		requested.push(url)

		if (url.endsWith("model-card.json")) {
			if (card === null) return new Response(null, { status: 404, statusText: "Not Found" })

			return new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } })
		}

		// Every other JSON asset 404s: the loader fetches lexicons TOLERANTLY, and the assertion
		// surface is which URL was DERIVED (recorded above), not what its body decoded to.
		if (url.endsWith(".json")) {
			return new Response(null, { status: 404, statusText: "Not Found" })
		}

		return new Response(new Uint8Array([1, 2, 3]))
	}) as unknown as typeof fetch
}

function installMockSession(): void {
	sessionCreateMock.mockReset()

	sessionCreateMock.mockResolvedValue({
		inputNames: ["input_ids", "attention_mask"],
		run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(128 * 3), dims: [1, 128, 3] } })),
	})
}

async function loadWithCard(card: object | null): Promise<string[]> {
	const requested: string[] = []

	await loadNeuralClassifierFromURLs({
		modelURL: `${BASE}/model.onnx`,
		tokenizerURL: `${BASE}/tokenizer.model`,
		modelCardURL: `${BASE}/model-card.json`,
		fetchImpl: makeRecordingFetch(card, requested),
	})

	return requested
}

describe("card-declared lexicon generations", () => {
	beforeEach(() => {
		installMockSession()
	})

	test("a card naming locality-surface v7 resolves v7, never the legacy v6 sibling", async () => {
		const requested = await loadWithCard({
			labels: ["O", "B-locality", "I-locality"],
			requires: {
				locality_surface: { required: true, lexicon: "locality-surface-lexicon-v7.json" },
				street_type: { required: true, lexicon: "street-type-lexicon-v3.json" },
			},
		})

		expect(requested).toContain(`${BASE}/locality-surface-lexicon-v7.json`)
		expect(requested).not.toContain(`${BASE}/locality-surface-lexicon-v6.json`)
		expect(requested).toContain(`${BASE}/street-type-lexicon-v3.json`)
	})

	test("a card without lexicon declarations falls back to the legacy sibling names", async () => {
		const requested = await loadWithCard({ labels: ["O", "B-locality", "I-locality"] })

		expect(requested).toContain(`${BASE}/locality-surface-lexicon-v6.json`)
	})

	test("a 404 card keeps the legacy sibling names (pre-card bundles)", async () => {
		const requested = await loadWithCard(null)

		expect(requested).toContain(`${BASE}/locality-surface-lexicon-v6.json`)
	})

	test("an explicit caller URL always wins over the card", async () => {
		const requested: string[] = []

		await loadNeuralClassifierFromURLs({
			modelURL: `${BASE}/model.onnx`,
			tokenizerURL: `${BASE}/tokenizer.model`,
			modelCardURL: `${BASE}/model-card.json`,
			localitySurfaceLexiconURL: "https://elsewhere.example/custom-lexicon.json",
			fetchImpl: makeRecordingFetch(
				{ requires: { locality_surface: { lexicon: "locality-surface-lexicon-v7.json" } } },
				requested
			),
		})

		expect(requested).toContain("https://elsewhere.example/custom-lexicon.json")
		expect(requested).not.toContain(`${BASE}/locality-surface-lexicon-v7.json`)
	})
})
