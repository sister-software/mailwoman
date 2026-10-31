/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests on the packaged en-US weights that tracing leaves the parse unchanged and that the decode
 *   explanation's terms add up to the decoder's score and to each span's margin.
 */

import { buildAddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it, vi } from "vitest"

import { NeuralAddressClassifier } from "#classifier"
import { DECODE_TERMS, type DecodeTermValues } from "#decode-explanation"

import { MODEL_LOAD_TEST_TIMEOUT_MS, testModelAssets } from "../test/model-assets.ts"

const assets = await testModelAssets()

vi.setConfig({ testTimeout: MODEL_LOAD_TEST_TIMEOUT_MS })

const ADDRESSES = [
	"350 5th Ave, New York, NY 10118",
	"BULEVARDI ZOGU I, NR. 1, TIRANE, Albania",
	"Wilmslow Road, Didsbury, Manchester, M20 2QZ",
	"Im Kirchfeld 17, Löcken, 52525 Waldfeucht",
	"3 Daly Street, Maryborough VIC 3465",
]

let load: Promise<NeuralAddressClassifier> | null = null

function classifier(): Promise<NeuralAddressClassifier> {
	load ??= NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })

	return load
}

function termTotal(values: DecodeTermValues): number {
	return DECODE_TERMS.reduce((total, term) => total + values[term], 0)
}

describe.skipIf(!assets)("NeuralAddressClassifier trace on the packaged weights", () => {
	it.each(ADDRESSES)("parses %s identically with tracing on and off", async (address) => {
		const cls = await classifier()
		const tree = await cls.parse(address)
		const trace = await cls.traceParse(address)
		// `parse` also attaches the locale head's prediction.
		// The token-built tree has no field for it.
		const { localeCountry: _localeCountry, ...built } = tree

		expect(buildAddressTree(trace.text, trace.tokens, { country: trace.containmentCountry })).toEqual(built)
		await expect(cls.parse(address)).resolves.toEqual(tree)
	})

	it.each(ADDRESSES)("explains %s with terms that sum to the decoder's score and each margin", async (address) => {
		const explanation = (await (await classifier()).traceParse(address)).explanation!

		expect(termTotal(explanation.decodedTerms)).toBeCloseTo(explanation.decoderScore, 4)

		for (const span of explanation.spans) {
			expect(termTotal(span.termMargins!)).toBeCloseTo(span.margin!, 4)
			expect(span.margin!).toBeGreaterThanOrEqual(0)
		}
	})
})
