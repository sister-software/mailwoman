// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A model without the outcome hint or head under the runtime that reads them
 *   (`docs/engineering/reference/outcome-kinds.mdx`, Compatibility of the graph).
 *
 *   The published weights declare no `outcome_hint` input, so the runtime packs no feed
 *   and the parse is the model's own: a parse with a hint equals the parse without one,
 *   and the tree holds no outcome distribution.
 */

import { describe, expect, test, vi } from "vitest"

import { NeuralAddressClassifier } from "#classifier"

import { MODEL_LOAD_TEST_TIMEOUT_MS, testModelAssets } from "../../test/model-assets.ts"

const haveModel = (await testModelAssets()) !== null

vi.setConfig({ testTimeout: MODEL_LOAD_TEST_TIMEOUT_MS })

const INPUTS = [
	"Mt. Tabor",
	"Mt. Tabor Park",
	"Mt. Tabor, Portland, Oregon",
	"1600 Amphitheatre Parkway, Mountain View, CA",
]

describe.skipIf(!haveModel)("the published en-US weights under the outcome runtime", () => {
	test.each(INPUTS)("%s parses the same with and without a hint", async (text) => {
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const plain = await classifier.parse(text)

		expect(plain.outcomeDistribution ?? null).toBeNull()

		for (const outcomeHint of ["natural.mountain", "place", "venue", "landmark"]) {
			expect(await classifier.parse(text, { outcomeHint })).toEqual(plain)
		}
	})
})
