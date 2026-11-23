// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The test compares the recognizer the pipeline reads, `computeQueryShape` from
 *   `@mailwoman/postcode/recognizer/query-shape`, with the frozen output of the legacy classifier.
 *
 *   It checks the six structural fields and `knownFormats` on every case of
 *   `@mailwoman/recognizer`'s fixture, then checks the family's own contracts.
 *
 *   The fixture's cases include the golden inputs, the legacy behaviors that look accidental,
 *   generated inputs dense in postcode shapes and PO box leaders, and gauntlet inputs.
 *   The real-row comparison ran once against the legacy package before it was deleted,
 *   and its summary is `data/reports/known-formats-differential.json`.
 */

import { RecognizerCompositionError, createRecognizer } from "@mailwoman/recognizer"
import { structure } from "@mailwoman/recognizer/structure"
import { plainFields, readFrozenFixture } from "@mailwoman/recognizer/tools/frozen"
import type { StructureFields } from "@mailwoman/recognizer/types"
import { describe, expect, it } from "vitest"

import { postcodeLegacy } from "#recognizer/legacy"
import { computeQueryShape } from "#recognizer/query-shape"
import { generatedKnownFormatInputs, recognizedHits } from "#tools/differential"

describe("computeQueryShape equals the frozen legacy output", () => {
	it("on every case of the fixture, in the six fields and in knownFormats", async () => {
		const fixture = await readFrozenFixture()

		const differences = fixture.cases
			.map(({ category, input, fields: frozen }) => {
				// The legacy generation reports each region abbreviation's text as `span`, as `StructureFields` types it.
				const recognized = plainFields(computeQueryShape(input) as StructureFields)

				// oxlint-disable-next-line no-restricted-properties -- the comparison needs a canonical text of plain data
				return JSON.stringify(recognized) === JSON.stringify(frozen) ? null : { category, input, recognized, frozen }
			})
			.filter((difference) => difference !== null)

		expect(differences.slice(0, 5)).toEqual([])
	})

	it("reads a normalized input's normalized text", () => {
		expect(computeQueryShape({ raw: "x", normalized: "SW1A 1AA" })).toEqual(computeQueryShape("SW1A 1AA"))
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

	it("index the text on fresh generated inputs", () => {
		for (const text of generatedKnownFormatInputs(2000, 424_242)) {
			for (const { span } of recognizedHits(text)) {
				expect(text.slice(span.start, span.end)).toBe(span.body)
			}
		}
	})
})

describe("createRecognizer with the postcode_legacy family", () => {
	it("refuses a composition without the structure family, with a typed error at construction", () => {
		expect(() => createRecognizer([postcodeLegacy])).toThrow(RecognizerCompositionError)
		expect(() => createRecognizer([structure, postcodeLegacy])).not.toThrow()
	})

	it("reports no recognitions of its own", () => {
		expect(createRecognizer([structure, postcodeLegacy]).recognize("12345").recognitions).toEqual([])
	})
})
