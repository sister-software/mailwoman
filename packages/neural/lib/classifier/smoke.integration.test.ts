/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end smoke test for `NeuralAddressClassifier` over the test model that
 *   `test/model-assets.ts` selects: the `MAILWOMAN_TEST_ONNX_MODEL` override, or the packaged en-US
 *   weights. A checkout with neither skips the suite.
 */

import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "#classifier"

import { testModelAssets } from "../../test/model-assets.ts"

const assets = await testModelAssets()
const haveModel = assets !== null

/**
 * A classifier over the test model, with the labels of the model card beside it.
 */
function loadClassifier(): Promise<NeuralAddressClassifier> {
	return NeuralAddressClassifier.loadFromWeights({ modelPath: assets!.modelPath, tokenizerPath: assets!.tokenizerPath })
}

describe.skipIf(!haveModel)("NeuralAddressClassifier — smoke over the test model", () => {
	test("parses the white-house address into a non-empty tree", async () => {
		const cls = await loadClassifier()

		const tree = await cls.parse("1600 Pennsylvania Avenue NW, Washington, DC 20500")
		expect(tree.roots.length).toBeGreaterThan(0)
	})

	test("parseXML emits an <address> root with at least one component", async () => {
		const cls = await loadClassifier()

		const xml = await cls.parseXML("75004 Paris")
		expect(xml).toMatch(/^<address /)
		expect(xml).toContain("</address>")
	})

	test("parseJSON returns at least one coarse component for a familiar address", async () => {
		const cls = await loadClassifier()

		const json = await cls.parseJSON("Washington, DC 20500")
		const coarseHits = ["country", "region", "locality", "postcode"].filter((k) => k in json)
		expect(coarseHits.length).toBeGreaterThan(0)
	})

	test("empty input returns empty tree without error", async () => {
		const cls = await loadClassifier()

		const tree = await cls.parse("")
		expect(tree.roots).toEqual([])
	})
})
