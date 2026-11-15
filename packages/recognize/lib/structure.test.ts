// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family at the TypeScript boundary: the typed fields, UTF-16 offsets
 *   and the rule that a recognizer without the family adds no fields.
 *
 *   The equality with `computeQueryShape` is tested in `tools/differential.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from "vitest"

import { coordinates } from "#coordinates"
import { createRecognizer, type StructureFields } from "#index"
import { structure } from "#structure"

describe("the structure family", () => {
	it("types the fields it adds and reports no recognition", () => {
		const { fields, recognitions } = createRecognizer([structure]).recognize("350 5th Ave, New York, NY 10118")

		expectTypeOf(fields).toEqualTypeOf<StructureFields>()
		expect(recognitions).toEqual([])
		expect(fields.characterClass).toBe("alphanumeric")
		expect(fields.segments.map((segment) => segment.body)).toEqual(["350 5th Ave", "New York", "NY 10118"])
		expect(fields.regionAbbreviations).toEqual([{ start: 23, span: "NY" }])
		expect(fields.totalLength).toBe(31)
	})

	it("reports offsets in UTF-16 code units past an astral character", () => {
		const { fields } = createRecognizer([structure]).recognize("😀 abc, 東京")

		expect(fields.tokenClasses.map(({ span }) => [span.start, span.end, span.body])).toEqual([
			[0, 2, "😀"],
			[3, 6, "abc"],
			[8, 10, "東京"],
		])
	})

	it("composes with a family that adds recognitions", () => {
		const { fields, recognitions } = createRecognizer([structure, coordinates]).recognize("40.5, -74")

		expect(recognitions.map(({ kind }) => kind)).toContain("coordinate.decimal_pair")
		// The point splits `40.5` into two tokens and the leading hyphen of `-74` is skipped.
		expect(fields.tokenClasses.map(({ span }) => span.body)).toEqual(["40", "5", "74"])
	})

	it("is absent from the fields of a recognizer that omits it", () => {
		expect(createRecognizer([coordinates]).recognize("1, 2").fields).toEqual({})
	})

	it("refuses a text over the family's input limit with a RangeError", () => {
		expect(() => createRecognizer([structure]).recognize("a".repeat((1 << 20) + 1))).toThrow(RangeError)
	})
})
