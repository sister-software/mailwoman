/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { alignRow } from "./align.js"
import { whitespaceTokenizer } from "./tokenize.js"
import type { CanonicalRow } from "./types.js"

const baseRow = (over: Partial<CanonicalRow>): CanonicalRow => ({
	raw: "",
	components: {},
	country: "US",
	source: "test",
	source_id: "t-1",
	corpus_version: "0.1.0",
	license: "CC0-1.0",
	...over,
})

describe("whitespaceTokenizer", () => {
	it("splits on whitespace and punctuation, preserves accents + apostrophes + hyphens", () => {
		const t = whitespaceTokenizer().tokenize("1600 Pennsylvania Ave NW, Washington")
		expect(t.map((x) => x.text)).toEqual(["1600", "Pennsylvania", "Ave", "NW", "Washington"])
		expect(t[0]!.start).toBe(0)
		expect(t[0]!.end).toBe(4)
		expect(t[3]!.text).toBe("NW")
	})

	it("keeps unicode letters together (Île-de-France)", () => {
		const t = whitespaceTokenizer().tokenize("Île-de-France")
		expect(t.map((x) => x.text)).toEqual(["Île-de-France"])
	})

	it("keeps apostrophes (Champs-Élysées d'Or)", () => {
		const t = whitespaceTokenizer().tokenize("Avenue d'Iéna")
		expect(t.map((x) => x.text)).toEqual(["Avenue", "d'Iéna"])
	})

	it("drops standalone punctuation and emits nothing for whitespace-only input", () => {
		const t = whitespaceTokenizer().tokenize("   ,  ")
		expect(t).toEqual([])
	})

	it("token spans align to the original string slice", () => {
		const raw = "Paris, France"
		const t = whitespaceTokenizer().tokenize(raw)
		for (const tok of t) {
			expect(raw.slice(tok.start, tok.end)).toBe(tok.text)
		}
	})
})

describe("alignRow — verbatim matches", () => {
	it("labels each component span with B-/I- tokens, others O", () => {
		const result = alignRow(
			baseRow({
				raw: "1600 Pennsylvania Ave NW, Washington, DC 20500",
				components: {
					house_number: "1600",
					street: "Pennsylvania Ave NW",
					locality: "Washington",
					region: "DC",
					postcode: "20500",
				},
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.tokens).toEqual(["1600", "Pennsylvania", "Ave", "NW", "Washington", "DC", "20500"])
		expect(result.row.labels).toEqual([
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"B-locality",
			"B-region",
			"B-postcode",
		])
	})

	it("labels a FR row with prefix/particle/street structure", () => {
		const result = alignRow(
			baseRow({
				raw: "10 Rue de la République, 75008 Paris",
				country: "FR",
				components: {
					house_number: "10",
					street: "Rue de la République",
					locality: "Paris",
					postcode: "75008",
				},
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.tokens).toEqual(["10", "Rue", "de", "la", "République", "75008", "Paris"])
		expect(result.row.labels).toEqual([
			"B-house_number",
			"B-street",
			"I-street",
			"I-street",
			"I-street",
			"B-postcode",
			"B-locality",
		])
	})

	it("does not double-claim overlapping component spans", () => {
		// Both "Paris" (locality) and "Paris" inside "Paris, Texas" could match a region
		// "Paris" if the corpus mis-labeled — guard via claimed-spans bookkeeping.
		const result = alignRow(
			baseRow({
				raw: "Paris Paris, France",
				country: "FR",
				components: { locality: "Paris", country: "France" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		// First "Paris" → locality, second "Paris" → unclaimed O
		expect(result.row.tokens).toEqual(["Paris", "Paris", "France"])
		expect(result.row.labels).toEqual(["B-locality", "O", "B-country"])
	})

	it("tokens.length === labels.length always", () => {
		const result = alignRow(
			baseRow({
				raw: "12 Main St, Springfield, IL 62701",
				components: { house_number: "12", street: "Main St", locality: "Springfield", region: "IL", postcode: "62701" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.tokens.length).toBe(result.row.labels.length)
	})
})

describe("alignRow — fuzzy fallback", () => {
	it("accepts an accent-stripped surface form within edit distance", () => {
		const result = alignRow(
			baseRow({
				raw: "75008 Paris, France",
				country: "FR",
				components: { locality: "Pâris", postcode: "75008" }, // typo / accent variant
			}),
			{ maxEditDistance: 2 }
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.labels).toContain("B-locality")
	})

	it("quarantines when component cannot be found at all", () => {
		const result = alignRow(
			baseRow({
				raw: "75008 Paris",
				components: { locality: "Paris", region: "Île-de-France" },
			})
		)
		expect(result.kind).toBe("quarantined")
		if (result.kind !== "quarantined") return
		expect(result.row.reason).toBe("component-not-found:region")
	})

	it("maxEditDistance: 0 forces verbatim", () => {
		const result = alignRow(
			baseRow({
				raw: "75008 Paris",
				components: { locality: "Pâris", postcode: "75008" }, // accent-bearing version
			}),
			{ maxEditDistance: 0 }
		)
		expect(result.kind).toBe("quarantined")
	})
})

describe("alignRow — edge cases", () => {
	it("quarantines on empty raw", () => {
		const result = alignRow(baseRow({ raw: "", components: { locality: "X" } }))
		expect(result.kind).toBe("quarantined")
		if (result.kind !== "quarantined") return
		expect(result.row.reason).toBe("raw-empty")
	})

	it("empty components → labels are all O", () => {
		const result = alignRow(baseRow({ raw: "Anywhere", components: {} }))
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.tokens).toEqual(["Anywhere"])
		expect(result.row.labels).toEqual(["O"])
	})

	it("case-insensitive matching is on by default; retained span has raw case", () => {
		const result = alignRow(
			baseRow({
				raw: "PARIS, FRANCE",
				country: "FR",
				components: { locality: "Paris", country: "France" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.tokens).toEqual(["PARIS", "FRANCE"])
		expect(result.row.labels).toEqual(["B-locality", "B-country"])
	})

	it("case-sensitive mode fails when surface case differs", () => {
		const result = alignRow(
			baseRow({
				raw: "PARIS",
				components: { locality: "Paris" },
			}),
			{ caseInsensitive: false, maxEditDistance: 0 }
		)
		expect(result.kind).toBe("quarantined")
	})

	it("preserves canonical row provenance + adds tokens/labels", () => {
		const row = baseRow({
			raw: "Paris",
			components: { locality: "Paris" },
			source: "wof-admin",
			source_id: "wof-admin-2011-self",
			license: "CC0-1.0",
		})
		const result = alignRow(row)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.source).toBe("wof-admin")
		expect(result.row.source_id).toBe("wof-admin-2011-self")
		expect(result.row.license).toBe("CC0-1.0")
		expect(result.row.country).toBe("US") // baseRow default
	})
})
