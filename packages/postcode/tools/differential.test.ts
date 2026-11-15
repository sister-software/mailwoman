// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `postcode_legacy` family's `knownFormats` against `computeQueryShape`:
 *   the golden fixture's 78 inputs, generated inputs dense in what triggers a hit,
 *   and the legacy behaviors that look accidental.
 *
 *   The real-row comparison is `tools/differential.run.ts`, and its summary is committed.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { RecognizeCompositionError, createRecognizer } from "@mailwoman/recognize"
import { structure } from "@mailwoman/recognize/structure"
import { describe, expect, it } from "vitest"

import { postcodeLegacy } from "#recognize"
import { compareKnownFormats, generatedKnownFormatInputs, recognizedHits } from "#tools/differential"

interface GoldenFixture {
	cases: Array<{ category: string; input: string }>
}

describe("the postcode_legacy family equals computeQueryShape", () => {
	it("on the golden fixture's inputs", async () => {
		const fixture = await readLocalJSONFile<GoldenFixture>(
			workspacePath("query-shape", "test", "fixtures", "compute-query-shape.golden.json").toString()
		)

		expect(fixture.cases).toHaveLength(78)

		expect(fixture.cases.map(({ input }) => compareKnownFormats(input)).filter(isPresent)).toEqual([])
	})

	it("on generated inputs dense in postcode shapes and PO box leaders", () => {
		const differences = generatedKnownFormatInputs(4000, 20_261_115).map(compareKnownFormats).filter(isPresent)

		expect(differences.slice(0, 5)).toEqual([])
	})

	it("on the behaviors that look accidental, which stay until both implementations change together", () => {
		const quirks = [
			"123-4567",
			"〒123-4567",
			"Box 1012, LG",
			"1012,\tLG",
			"1012\nLG",
			"po box 1 po box 2",
			"PO BOX",
			"po 1",
			"BP 12 BP 13",
			"apartado a b c 5",
			"box a b c 5",
			"ſw1a 1aa",
			"K1A 0B1",
			"12345",
			"123 45",
			"SW1A 1AA",
			"68161 68162",
		]

		expect(quirks.map(compareKnownFormats).filter(isPresent)).toEqual([])
	})
})

describe("the postcode_legacy family's hits", () => {
	it("keep the legacy order, names and confidences", () => {
		expect(recognizedHits("68161")).toEqual([
			{ format: "us_zip", span: { start: 0, end: 5, body: "68161" }, confidence: 0.6 },
			{ format: "fr_postcode", span: { start: 0, end: 5, body: "68161" }, confidence: 0.6 },
			{ format: "de_postcode", span: { start: 0, end: 5, body: "68161" }, confidence: 0.6 },
		])

		expect(recognizedHits("Box 1012, LG").map(({ format }) => format)).toEqual(["nl_postcode", "po_box"])
	})
})

describe("createRecognizer with the postcode_legacy family", () => {
	it("refuses a composition without the structure family, with a typed error at construction", () => {
		expect(() => createRecognizer([postcodeLegacy])).toThrow(RecognizeCompositionError)
		expect(() => createRecognizer([structure, postcodeLegacy])).not.toThrow()
	})

	it("reports no recognitions of its own", () => {
		expect(createRecognizer([structure, postcodeLegacy]).recognize("12345").recognitions).toEqual([])
	})
})
