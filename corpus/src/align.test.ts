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

	it("preserves canonical row provenance + adds tokens/labels + spans", () => {
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
		expect(result.row.span_tags).toEqual(["locality"])
		expect(result.row.span_starts).toEqual([0])
		expect(result.row.span_ends).toEqual([5])
	})
})

describe("alignRow — char-offset span emission (#519, v0.5.0 format)", () => {
	it("emits the parallel span triple alongside tokens/labels (both during the transition)", () => {
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
		// Token path untouched.
		expect(result.row.tokens.length).toBe(result.row.labels.length)
		// Span triple: parallel, sorted by start, each slice round-trips to the component surface.
		expect(result.row.span_tags).toEqual(["house_number", "street", "locality", "region", "postcode"])
		expect(result.row.span_starts).toEqual([0, 5, 26, 38, 41])
		expect(result.row.span_ends).toEqual([4, 24, 36, 40, 46])
		const { raw } = result.row
		expect(raw.slice(0, 4)).toBe("1600")
		expect(raw.slice(5, 24)).toBe("Pennsylvania Ave NW")
		expect(raw.slice(26, 36)).toBe("Washington")
		expect(raw.slice(38, 40)).toBe("DC")
		expect(raw.slice(41, 46)).toBe("20500")
	})

	it("punctuation between spans stays uncovered (the comma is outside both spans — expressible now)", () => {
		const result = alignRow(
			baseRow({
				raw: "Springfield, IL",
				components: { locality: "Springfield", region: "IL" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.span_starts).toEqual([0, 13])
		expect(result.row.span_ends).toEqual([11, 15])
		// The comma at offset 11 belongs to no span.
	})

	it("accented NFC raw (é = one code unit) offsets address the composed form", () => {
		const raw = "10 Rue de la République, 75008 Paris"
		expect(raw.normalize("NFC")).toBe(raw) // fixture sanity: source literal is NFC
		const result = alignRow(
			baseRow({
				raw,
				country: "FR",
				components: { house_number: "10", street: "Rue de la République", locality: "Paris", postcode: "75008" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.span_tags).toEqual(["house_number", "street", "postcode", "locality"])
		const streetStart = result.row.span_starts![1]!
		const streetEnd = result.row.span_ends![1]!
		expect(raw.slice(streetStart, streetEnd)).toBe("Rue de la République")
	})

	it("spans are sorted + non-overlapping across a variety of rows", () => {
		const rows = [
			baseRow({
				raw: "12 Main St, Springfield, IL 62701",
				components: { house_number: "12", street: "Main St", locality: "Springfield", region: "IL", postcode: "62701" },
			}),
			baseRow({
				raw: "Paris Paris, France",
				country: "FR",
				components: { locality: "Paris", country: "France" },
			}),
			baseRow({ raw: "Anywhere", components: {} }),
		]
		for (const row of rows) {
			const result = alignRow(row)
			expect(result.kind).toBe("labeled")
			if (result.kind !== "labeled") continue
			const { span_starts, span_ends, span_tags } = result.row
			expect(span_starts!.length).toBe(span_ends!.length)
			expect(span_starts!.length).toBe(span_tags!.length)
			for (let i = 1; i < span_starts!.length; i++) {
				expect(span_starts![i]!).toBeGreaterThanOrEqual(span_ends![i - 1]!) // sorted AND non-overlapping
			}
		}
	})

	it("empty components → empty span arrays (all-O row)", () => {
		const result = alignRow(baseRow({ raw: "Anywhere", components: {} }))
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		expect(result.row.span_starts).toEqual([])
		expect(result.row.span_ends).toEqual([])
		expect(result.row.span_tags).toEqual([])
	})

	it("throws loudly on a non-NFC raw, naming the row's source_id", () => {
		// NFD: "é" as base letter + combining acute — two code units where NFC has one.
		const nfdRaw = "10 Rue de la Re\u0301publique, 75008 Paris"
		expect(nfdRaw.normalize("NFC")).not.toBe(nfdRaw)
		expect(() =>
			alignRow(
				baseRow({
					raw: nfdRaw,
					country: "FR",
					source_id: "nfd-row-42",
					components: { locality: "Paris", postcode: "75008" },
				})
			)
		).toThrowError(/not NFC-normalized.*nfd-row-42/s)
	})

	it("does not throw on a non-NFC raw that is empty-ish (raw-empty quarantine wins)", () => {
		const result = alignRow(baseRow({ raw: "", components: {} }))
		expect(result.kind).toBe("quarantined")
	})
})

describe("alignRow — boundary-aligned match preference (the v0.5.0 pilot's Umak/AK bug)", () => {
	it("a short region value does not claim the inside of an earlier word", () => {
		// Pre-fix, leftmost-substring let region "AK" (case-insensitive) match inside "Umak",
		// scrambling every later span — 0.088% of the pilot shard, 46 natural rows.
		const result = alignRow(
			baseRow({
				raw: "Umak Cir, AK 99546",
				components: { street: "Umak", street_suffix: "Cir", region: "AK", postcode: "99546" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		const { raw, span_starts, span_ends, span_tags } = result.row
		const byTag = Object.fromEntries(span_tags!.map((t, i) => [t, raw.slice(span_starts![i]!, span_ends![i]!)]))
		expect(byTag).toEqual({ street: "Umak", street_suffix: "Cir", region: "AK", postcode: "99546" })
		// And specifically: the region span sits at the standalone "AK", not inside "Umak".
		const regionIdx = span_tags!.indexOf("region")
		expect(span_starts![regionIdx]).toBe(10)
	})

	it("intra-word matches survive as the fallback — affix supervision inside compounds", () => {
		// street_suffix "straße" has NO boundary-aligned occurrence in "Hauptstraße"; the sub-word
		// span is the point of the char-offset format and must not be quarantined by the fix.
		const result = alignRow(
			baseRow({
				raw: "Hauptstraße 5, 10827 Berlin",
				country: "DE",
				components: {
					street: "Haupt",
					street_suffix: "straße",
					house_number: "5",
					postcode: "10827",
					locality: "Berlin",
				},
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		const { raw, span_starts, span_ends, span_tags } = result.row
		const suffixIdx = span_tags!.indexOf("street_suffix")
		expect(raw.slice(span_starts![suffixIdx]!, span_ends![suffixIdx]!)).toBe("straße")
		expect(span_starts![suffixIdx]).toBe(5) // inside the compound, directly after "Haupt"
	})

	it("longest value locates first — a region homonym cannot steal the street's word (pilot2 residual)", () => {
		// "Alaska" is both the region and the street's first word; locating region first claimed
		// [0,6) and quarantined the street. Longest-first gives the street its full surface, and
		// the region then finds its own boundary-aligned occurrence.
		const result = alignRow(
			baseRow({
				raw: "Alaska Regional Dr, Alaska 99508",
				components: { street: "Alaska Regional Dr", region: "Alaska", postcode: "99508" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		const { raw, span_starts, span_ends, span_tags } = result.row
		const byTag = Object.fromEntries(span_tags!.map((t, i) => [t, [span_starts![i]!, span_ends![i]!]]))
		expect(raw.slice(...(byTag["street"] as [number, number]))).toBe("Alaska Regional Dr")
		expect(byTag["region"]).toEqual([20, 26])
	})

	it("the Lake/AK natural-row case from the pilot scan", () => {
		const result = alignRow(
			baseRow({
				raw: "Lake Dr, AK 99692",
				components: { street: "Lake", street_suffix: "Dr", region: "AK", postcode: "99692" },
			})
		)
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		const { raw, span_starts, span_ends, span_tags } = result.row
		for (let i = 0; i < span_tags!.length; i++) {
			const slice = raw.slice(span_starts![i]!, span_ends![i]!)
			expect(slice.trim()).toBe(slice) // no span carries edge whitespace
		}
		const regionIdx = span_tags!.indexOf("region")
		expect(raw.slice(span_starts![regionIdx]!, span_ends![regionIdx]!)).toBe("AK")
		expect(span_starts![regionIdx]).toBe(9)
	})
})
