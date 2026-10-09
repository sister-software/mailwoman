/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The model and tokenizer are fetched beside the model card, and the postcode binaries and pair indexes beside the
 *   model group.
 *   The runner hands a caller's early ORT wasm download to onnxruntime-web before the session is created.
 */

import { afterAll, describe, expect, test, vi } from "vitest"

const { sessionCreateMock, ortEnv } = vi.hoisted(() => ({
	sessionCreateMock: vi.fn(),
	ortEnv: { wasm: {} as { wasmBinary?: Uint8Array } },
}))

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

	return { Tensor, InferenceSession: { create: sessionCreateMock }, env: ortEnv }
})

vi.mock("#tokenizer", async (importOriginal) => ({
	...(await importOriginal<typeof import("#tokenizer")>()),
	MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
}))

vi.mock("#classifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("#classifier")>()),
	NeuralAddressClassifier: class {},
}))

// The root vitest config shares one module graph per worker, so the loader is re-evaluated against these mocks.
vi.resetModules()
afterAll(() => vi.resetModules())

const { loadNeuralClassifierFromURLs } = await import("#web/loader")

const SEQ = 128
const MODEL_URL = "https://cdn.example/mailwoman/v9/model.onnx"
const TOKENIZER_URL = "https://cdn.example/mailwoman/v9/tokenizer.model"
const CARD_URL = "https://cdn.example/mailwoman/v9/model-card.json"
const POSTCODE_URL = "https://cdn.example/mailwoman/v9/postcode-us.bin"
const PAIR_INDEX_URL = "https://cdn.example/pair-index/pair-index-gb.bin"

sessionCreateMock.mockResolvedValue({
	inputNames: ["input_ids", "attention_mask"],
	run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(SEQ * 3), dims: [1, SEQ, 3] } })),
})

function baseOpts(fetchImpl: typeof fetch) {
	return {
		modelURL: MODEL_URL,
		tokenizerURL: TOKENIZER_URL,
		gazetteerLexicon: "none" as const,
		countryLexicon: "none" as const,
		streetTypeLexicon: "none" as const,
		localitySurfaceLexicon: "none" as const,
		postcodeBinaryURLs: [POSTCODE_URL],
		pairIndexURLs: [PAIR_INDEX_URL],
		fetchImpl,
	}
}

describe("loadNeuralClassifierFromURLs request order", () => {
	test("the postcode and pair-index fetches start while the model download is still in flight", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const requested: string[] = []
		let releaseModel: () => void = () => {}

		const modelHeld = new Promise<void>((resolve) => {
			releaseModel = resolve
		})

		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input)
			requested.push(url)

			if (url === MODEL_URL) {
				await modelHeld
			}

			// The postcode and pair-index bytes fail to decode, so both optional channels are skipped with a warning.
			return new Response(new Uint8Array([1, 2, 3]))
		}

		const loading = loadNeuralClassifierFromURLs(baseOpts(fetchImpl))

		await vi.waitFor(() => expect(requested).toEqual(expect.arrayContaining([POSTCODE_URL, PAIR_INDEX_URL])))
		expect(requested).toContain(MODEL_URL)

		releaseModel()

		await expect(loading).resolves.toMatchObject({ pairIndexes: [] })

		warn.mockRestore()
	})

	test("the model and tokenizer fetches start before the model card resolves", async () => {
		const requested: string[] = []
		let releaseCard: () => void = () => {}

		const cardHeld = new Promise<void>((resolve) => {
			releaseCard = resolve
		})

		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input)
			requested.push(url)

			if (url === CARD_URL) {
				await cardHeld

				return new Response("{}", { status: 200 })
			}

			return new Response(new Uint8Array([1, 2, 3]))
		}

		const loading = loadNeuralClassifierFromURLs({
			...baseOpts(fetchImpl),
			modelCardURL: CARD_URL,
			postcodeBinaryURLs: [],
			pairIndexURLs: [],
		})

		await vi.waitFor(() => expect(requested).toEqual(expect.arrayContaining([MODEL_URL, TOKENIZER_URL])))
		expect(requested).toContain(CARD_URL)

		releaseCard()

		await expect(loading).resolves.toMatchObject({ pairIndexes: [] })
	})

	test("a failed card rejects with its own message while the model fetch it overlapped also fails", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input)

			if (url === CARD_URL) return new Response(null, { status: 500, statusText: "Server Error" })

			throw new TypeError("network down")
		}

		await expect(
			loadNeuralClassifierFromURLs({
				...baseOpts(fetchImpl),
				modelCardURL: CARD_URL,
				postcodeBinaryURLs: [],
				pairIndexURLs: [],
			})
		).rejects.toThrow(`fetch ${CARD_URL} failed: 500 Server Error`)
	})

	test("the runner hands an early wasm download to onnxruntime-web before creating the session", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const wasmBinary = new Uint8Array([0, 97, 115, 109])
		let binaryAtSessionCreate: Uint8Array | undefined

		sessionCreateMock.mockImplementationOnce(async () => {
			binaryAtSessionCreate = ortEnv.wasm.wasmBinary

			return {
				inputNames: ["input_ids", "attention_mask"],
				run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(SEQ * 3), dims: [1, SEQ, 3] } })),
			}
		})

		await loadNeuralClassifierFromURLs({
			...baseOpts(async () => new Response(new Uint8Array([1, 2, 3]))),
			runner: { wasmBinary: Promise.resolve(wasmBinary) },
		})

		expect(binaryAtSessionCreate).toBe(wasmBinary)

		warn.mockRestore()
	})
})
