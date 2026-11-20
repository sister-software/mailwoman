// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The browser loader must hand the classifier the anchor span mode the model card declares,
 *   as the Node loader and the scorer do, or a GB unit written with a space gets no anchor signal.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { serializePostcodeBinary } from "@mailwoman/postcode/binary-resolver"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

import { shapedKeyerObligationViolation } from "#anchor-inference"
import type { NeuralAddressClassifierConfig } from "#classifier/options"

const { sessionCreateMock, constructed } = vi.hoisted(() => ({
	sessionCreateMock: vi.fn(),
	constructed: [] as unknown[],
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

	return { Tensor, InferenceSession: { create: sessionCreateMock }, env: { wasm: {} } }
})

vi.mock("#tokenizer", async (importOriginal) => ({
	...(await importOriginal<typeof import("#tokenizer")>()),
	MailwomanTokenizer: { loadFromBase64: vi.fn(async () => ({ tokenizerStub: true })) },
}))

vi.mock("#classifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("#classifier")>()),
	NeuralAddressClassifier: class {
		constructor(config: unknown) {
			constructed.push(config)
		}
	},
}))

vi.resetModules()
afterAll(() => vi.resetModules())

const { loadNeuralClassifierFromURLs } = await import("#web/loader")

const BASE = "https://cdn.example/mailwoman/v11.2.0"
const POSTCODE_URL = `${BASE}/postcode-gb.bin`

// A GB unit key.
// Only a `shaped` or `postal` scan produces it from "SW1A 1AA".
const GB_UNIT_BINARY = new Uint8Array(
	serializePostcodeBinary([{ postcode: "SW1A1AA", country: "GB", lat: 51.501, lon: -0.142 }])
)

function fetchServing(card: object): typeof fetch {
	return async (input) => {
		const url = String(input)

		if (url.endsWith("model-card.json")) {
			return new Response(stringifyJSON(card), { headers: { "content-type": "application/json" } })
		}

		if (url === POSTCODE_URL) return new Response(GB_UNIT_BINARY)

		if (url.endsWith(".json")) return new Response(null, { status: 404, statusText: "Not Found" })

		return new Response(new Uint8Array([1, 2, 3]))
	}
}

async function configForCard(card: object): Promise<NeuralAddressClassifierConfig> {
	constructed.length = 0

	await loadNeuralClassifierFromURLs({
		postcodeBinaryURLs: [POSTCODE_URL],
		pairIndexURLs: [],
		modelURL: `${BASE}/model.onnx`,
		tokenizerURL: `${BASE}/tokenizer.model`,
		modelCardURL: `${BASE}/model-card.json`,
		fetchImpl: fetchServing(card),
	})

	expect(constructed).toHaveLength(1)

	return constructed[0] as NeuralAddressClassifierConfig
}

describe("card-declared anchor span mode", () => {
	beforeEach(() => {
		sessionCreateMock.mockReset()

		sessionCreateMock.mockResolvedValue({
			inputNames: ["input_ids", "attention_mask", "anchor_features", "anchor_confidence"],
			run: vi.fn(() => Promise.resolve({ logits: { data: new Float32Array(128 * 3), dims: [1, 128, 3] } })),
		})
	})

	test("a card declaring postal reaches the classifier as postal, so a GB unit lookup raises no warning", async () => {
		const config = await configForCard({
			labels: ["O", "B-postcode", "I-postcode"],
			requires: { anchor: { required: true, span_mode: "postal" } },
		})

		expect(config.postcodeAnchorSpanMode).toBe("postal")
		expect(config.postcodeAnchorLookup).toBeTruthy()

		expect(
			shapedKeyerObligationViolation(config.postcodeAnchorLookup ?? null, config.postcodeAnchorSpanMode ?? null, null)
		).toBeNull()
	})

	test("the same lookup under a card without a span mode raises the warning", async () => {
		const config = await configForCard({
			labels: ["O", "B-postcode", "I-postcode"],
			requires: { anchor: { required: true } },
		})

		expect(config.postcodeAnchorSpanMode).toBeUndefined()

		expect(
			shapedKeyerObligationViolation(config.postcodeAnchorLookup ?? null, config.postcodeAnchorSpanMode ?? null, null)
		).toMatch(/GB unit keys/)
	})
})
