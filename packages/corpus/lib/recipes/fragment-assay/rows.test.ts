/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Each `fragment-assay` renderer's spans cover the text they claim, in code points, and agree with its labels.
 */

import { pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"
import { describe, expect, it } from "vitest"

import {
	codexCountrySurfaces,
	type FragmentRow,
	renderCompactUnit,
	renderContext,
	renderCountryContext,
	renderCountryLeading,
	renderFragment,
	renderLocalityPostcode,
	renderLocalityRegion,
} from "#recipes/fragment-assay/rows"

/**
 * Multi-word surfaces throughout, because a single-word field hides an `I-` continuation bug.
 */
const CASES: Record<string, FragmentRow> = {
	bare_street: renderFragment("Vestre Haugen", null),
	street_number: renderFragment("Vestre Haugen", "74"),
	bare_locality: renderFragment("Eight Mile Plains", null, "locality"),
	locality_postcode: renderLocalityPostcode("Eight Mile Plains", "4113"),
	context_trailing: renderContext("Rue Henri Barbusse", "12", "Saint Denis", "FI", true, false),
	context_leading_with_country: renderContext("Main Street", "12", "New Plymouth", "NZ", false, true),
	unit: renderCompactUnit("UNIT 711", "139", "BOUVERIE STREET"),
	admin_pair: renderLocalityRegion("Eight Mile Plains", "New South Wales"),
	country_context_comma: renderCountryContext(
		"Rue Henri Barbusse",
		"12",
		"Saint Denis",
		"United States of America",
		true,
		true
	),
	country_context_bare: renderCountryContext(
		"Main Street",
		"12",
		"New Plymouth",
		"United States of America",
		false,
		false
	),
	country_leading: renderCountryLeading("United States of America", "Wyoming", "Лорейн"),
	supplementary_plane: renderCountryLeading("United States", "Wyoming", "𠮷野"),
}

describe.each(Object.entries(CASES))("%s", (_, row) => {
	const characters = [...row.raw]
	const covered = row.span_starts.map((start, index) => characters.slice(start, row.span_ends[index]).join(""))

	it("covers each surface exactly, with no edge space", () => {
		for (const [index, text] of covered.entries()) {
			expect(row.span_starts[index]).toBeLessThan(row.span_ends[index]!)
			expect(text).toBe(text.trim())
		}
	})

	it("reconstructs the tokens from the spans, one label per token", () => {
		expect(pythonSplitWhitespace(covered.join(" "))).toEqual(row.tokens)
		expect(row.labels).toHaveLength(row.tokens.length)
	})

	it("opens each field with B- and names the span tags in order", () => {
		let previous: string | null = null

		for (const label of row.labels) {
			const [prefix, tag] = label.split("-", 2) as [string, string]

			if (prefix === "I") {
				expect(previous).toBe(tag)
			}

			previous = tag
		}

		expect(row.labels.filter((label) => label.startsWith("B-")).map((label) => label.slice(2))).toEqual(row.span_tags)
	})
})

describe("renderFragment", () => {
	it("keeps a house number with a space as one token, as the Python renderer appended it", () => {
		expect(renderFragment("Hämeenkatu", "12 a")).toMatchObject({
			raw: "Hämeenkatu 12 a",
			tokens: ["Hämeenkatu", "12 a"],
			labels: ["B-street", "B-house_number"],
			span_starts: [0, 11],
			span_ends: [10, 15],
		})
	})
})

describe("codexCountrySurfaces", () => {
	it("keeps the forms of three characters or more, in the codex's order", () => {
		const surfaces = codexCountrySurfaces()

		expect(surfaces.get("US")).toEqual([
			"United States",
			"USA",
			"U.S.A.",
			"U.S.",
			"United States of America",
			"America",
		])
		expect(surfaces.get("CZ")?.length).toBeGreaterThan(0)
	})
})
