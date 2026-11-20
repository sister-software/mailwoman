// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

import { findPostcodeSpans } from "#postal-spans"
import { disjointSpans } from "#recognizer/postal"

function texts(raw: string, spans: ReadonlyArray<{ start: number; end: number }>): string[] {
	return spans.map((span) => raw.slice(span.start, span.end))
}

describe("findPostcodeSpans", () => {
	test("finds a lower-case postcode, which the family's one case rule admits", () => {
		expect(texts("10 Downing St, London sw1a 2aa", findPostcodeSpans("10 Downing St, London sw1a 2aa"))).toContain(
			"sw1a 2aa"
		)
	})

	test("leaves a printed prefix and the white space after it out of the span", () => {
		const raw = "〒 100-0001 東京都"

		expect(texts(raw, findPostcodeSpans(raw))).toEqual(["100-0001"])
	})

	test("drops a piece a connector separates from a longer code, and keeps one beside a connector alone", () => {
		const cep = "RUA SEM DENOMINACAO 1, 270, Parintins, 69152-656"

		expect(texts(cep, findPostcodeSpans(cep))).toContain("69152-656")
		expect(texts(cep, findPostcodeSpans(cep))).not.toContain("69152")
		expect(texts("Model Town, Lahore-54000", findPostcodeSpans("Model Town, Lahore-54000"))).toContain("54000")
	})

	test("lists the longer candidate first and keeps the ZIP code inside it", () => {
		const raw = "Burlington, VT 05401 USA"
		const found = texts(raw, findPostcodeSpans(raw))

		expect(found[0]).toBe("VT 05401")
		expect(found).toContain("05401")
	})

	test("orders candidates longest first, with each range once", () => {
		const spans = findPostcodeSpans("D02 AF30 Dublin 12345")
		const lengths = spans.map((span) => span.end - span.start)

		expect(lengths).toEqual(lengths.toSorted((a, b) => b - a))
		expect(new Set(spans.map((span) => `${span.start}:${span.end}`)).size).toBe(spans.length)
	})

	test("an empty text has no candidate", () => {
		expect(findPostcodeSpans("")).toEqual([])
	})
})

describe("disjointSpans", () => {
	test("keeps the first of two overlapping candidates, and a refused candidate hides nothing", () => {
		const raw = "Burlington, VT 05401 USA"
		const spans = findPostcodeSpans(raw)

		expect(texts(raw, disjointSpans(spans))[0]).toBe("VT 05401")

		expect(
			texts(
				raw,
				disjointSpans(spans, (span) => raw.slice(span.start, span.end) === "05401")
			)
		).toEqual(["05401"])
	})
})

describe("the agreement fixture", () => {
	test("holds the candidates this finder returns for every row, which the encoder's finder replays", async () => {
		const fixture = await readLocalJSONFile<{ rows: Array<{ raw: string; spans: number[][] }> }>(
			repoRootPath("test", "fixtures", "postcode-agreement.json")
		)

		expect(fixture.rows.length).toBeGreaterThanOrEqual(1000)

		for (const row of fixture.rows) {
			expect(
				findPostcodeSpans(row.raw).map((span) => [span.start, span.end]),
				row.raw
			).toEqual(row.spans)
		}
	})
})
