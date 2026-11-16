// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `postal` generation of `computeQueryShape`, one test for each of the eleven behaviors
 *   of the legacy generation that the generation changes, and for the postcode hits.
 *
 *   Each test states the legacy answer beside the new one, so the change stays visible.
 */

import { hasCountry } from "@mailwoman/codex/country/sets"
import { describe, expect, it } from "vitest"

import { computeQueryShape } from "#recognize/query-shape"

const postal = (text: string) => computeQueryShape(text, "postal")
const legacy = (text: string) => computeQueryShape(text, "legacy")

describe("the postcode hits of the postal generation", () => {
	it("records its generation on the shape", () => {
		expect(postal("x").generation).toBe("postal")
		expect(legacy("x").generation).toBeUndefined()
	})

	it("reports a postcode hit with the accepting countries, the form and the locale of the most populous one", () => {
		const hit = postal("SW1A 1AA").knownFormats.find((candidate) => candidate.span.body === "SW1A 1AA")

		expect(hit).toMatchObject({ format: "postcode", form: "alnum", locale: "en-GB" })
		expect(hasCountry(hit!.countries!, "GB")).toBe(true)
	})

	it("scores a form fewer countries accept above a form more countries accept", () => {
		const few = postal("12345-6789").knownFormats[0]!
		const many = postal("68161").knownFormats[0]!

		expect(few.confidence).toBeGreaterThan(many.confidence)
		expect(many.confidence).toBeCloseTo(0.55, 2)
	})

	it("reports no hit for a word that a letter-only form accepts", () => {
		expect(postal("New York").knownFormats).toEqual([])
	})

	it("reports no hit for ordinary text that a country's form accepts", () => {
		// `Lot 19` and `Qld 4069` match Maltese and Irish forms, and a run of four digits is a house number or a year.
		expect(postal("LOT 19").knownFormats).toEqual([])
		expect(postal("Brookfield QLD 4069").knownFormats).toEqual([])
		expect(postal("PETER J. DONALDSON (1996) LTD.").knownFormats).toEqual([])
	})

	it("keeps the digit-led and the mixed forms and a run of five digits", () => {
		for (const text of ["1012 AB", "SW1A 1AA", "K1A 0B1", "12345"]) {
			expect(
				postal(text).knownFormats.some(({ span }) => span.body === text),
				text
			).toBe(true)
		}
	})
})

describe("the eleven behaviors", () => {
	it("1: reports Greek as alpha, where the legacy generation reported alphanumeric and the script Zzzz", () => {
		expect(legacy("Αθήνα").characterClass).toBe("alphanumeric")
		expect(legacy("Αθήνα").tokenClasses[0]!.script).toBe("Zzzz")
		expect(postal("Αθήνα").characterClass).toBe("alpha")
		expect(postal("Αθήνα").tokenClasses[0]).toMatchObject({ class: "alpha", script: "Grek" })
	})

	it("1: reads Hebrew, Thai and Devanagari by their own scripts", () => {
		expect(postal("רחוב הרצל").scripts.map(({ script }) => script)).toEqual(["Hebr"])
		expect(postal("ถนนสุขุมวิท").scripts[0]!.script).toBe("Thai")
		expect(postal("गांधी मार्ग").scripts[0]!.script).toBe("Deva")
	})

	it("2: reports 123-4567 as a digit form that two countries accept, not as a Japanese code at 0.95", () => {
		expect(legacy("123-4567").knownFormats[0]).toMatchObject({ format: "jp_postcode", confidence: 0.95 })
		expect(postal("123-4567").knownFormats[0]).toMatchObject({ format: "postcode", form: "numeric" })
		expect(postal("123-4567").knownFormats[0]!.confidence).toBeLessThan(0.9)
	})

	it("2: reports the printed prefix of a Japanese code as the designated form at the highest confidence", () => {
		const designated = postal("〒100-0001").knownFormats.find((hit) => hit.form === "designated")

		expect(designated).toMatchObject({ locale: "ja-JP", confidence: 0.95 })
	})

	it("3: reports no two-token postcode across a comma", () => {
		expect(legacy("Box 1012, LG").knownFormats.map(({ format }) => format)).toContain("nl_postcode")
		expect(postal("Box 1012, LG").knownFormats.some(({ span }) => span.body.includes(","))).toBe(false)
	})

	it("4: a zero-width space neither blocks a postcode nor sets the script", () => {
		const legacyShape = legacy("​12345")
		const shape = postal("​12345")

		expect(legacyShape.tokenClasses[0]!.script).toBe("Zzzz")
		expect(legacyShape.knownFormats).toEqual([])

		expect(shape.tokenClasses[0]).toMatchObject({
			class: "digit",
			script: "Zyyy",
			span: { start: 1, end: 6, body: "12345" },
		})

		expect(shape.knownFormats[0]!.span).toMatchObject({ start: 1, end: 6 })
	})

	it("5: reads fullwidth Latin letters as Latin and alpha, not as cjk", () => {
		expect(legacy("ＡＢＣ １２３").characterClass).toBe("cjk")
		expect(postal("ＡＢＣ １２３").characterClass).toBe("alphanumeric")
		expect(postal("ＡＢＣ １２３").scripts[0]!.script).toBe("Latn")
	})

	it("6: reports every PO box", () => {
		expect(legacy("PO Box 5, BP 7").knownFormats.filter(({ format }) => format === "po_box")).toHaveLength(1)

		expect(
			postal("PO Box 5, BP 7")
				.knownFormats.filter(({ format }) => format === "po_box")
				.map(({ span }) => span.body)
		).toEqual(["PO Box 5", "BP 7"])
	})

	it("7: ranks equal scripts by the earlier start, in the token and in the text", () => {
		// The legacy token rule gave a tie to the script seen first, and the legacy text ranking gave it to the code.
		expect(postal("北a").tokenClasses[0]!.script).toBe("Hani")
		expect(postal("a北").tokenClasses[0]!.script).toBe("Latn")
		expect(postal("北a").scripts.map(({ script }) => script)).toEqual(["Hani", "Latn"])
		expect(postal("a北").scripts.map(({ script }) => script)).toEqual(["Latn", "Hani"])
	})

	it("7: a tie that starts together goes to the longer run, then to the code", () => {
		// `ａ` and `я` start at different offsets, so build a tie of two scripts that each hold one run of the same length.
		expect(postal("я a").scripts.map(({ script }) => script)).toEqual(["Cyrl", "Latn"])
		expect(postal("a я").scripts.map(({ script }) => script)).toEqual(["Latn", "Cyrl"])
	})

	it("8: reports a region abbreviation that a table holds, in any segment, with its countries", () => {
		const first = postal("NY 10118")
		const later = postal("Albany, NY 10118")
		const countries = (text: string) => postal(text).regionAbbreviations[0]!.countries!

		expect(first.regionAbbreviations).toHaveLength(1)
		expect(later.regionAbbreviations).toHaveLength(1)
		expect(hasCountry(countries("Albany, NY 10118"), "US")).toBe(true)
		// WA and NT belong to two countries each.
		expect(hasCountry(countries("Perth, WA"), "AU") && hasCountry(countries("Perth, WA"), "US")).toBe(true)
	})

	it("8: reports no abbreviation for two capitals that no table holds", () => {
		expect(legacy("Main St, NW, Washington").regionAbbreviations).toHaveLength(1)
		expect(postal("Main St, NW, Washington").regionAbbreviations).toEqual([])
	})

	it("9: every hit owns its span object", () => {
		const shape = postal("68161")

		expect(shape.knownFormats[0]!.span).not.toBe(shape.tokenClasses[0]!.span)
		const old = legacy("68161")

		// The reader the swap installed builds a fresh span for each hit in both generations,
		// so the shared object of the original classifier is already gone from the legacy generation.
		expect(old.knownFormats[0]!.span).not.toBe(old.tokenClasses[0]!.span)
	})

	it("9: a write through one span leaves the others unchanged", () => {
		const shape = postal("PO Box 5")
		const [hit] = shape.knownFormats

		const before = shape.tokenClasses[0]!.span.start

		;(hit!.span as { start: number }).start = 99

		expect(shape.tokenClasses[0]!.span.start).toBe(before)
	})

	it("11: a region abbreviation holds a span of offsets", () => {
		const [abbreviation] = postal("Albany, NY").regionAbbreviations

		expect(legacy("Albany, NY").regionAbbreviations[0]!.span).toBe("NY")
		expect(abbreviation!.span).toEqual({ start: 8, end: 10, body: "NY" })
	})
})
