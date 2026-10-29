import { describe, expect, it } from "vitest"

import {
	commonCountryName,
	endsInLocalityCountry,
	firstByTextHash,
	trailingCountryRow,
} from "#tools/eval-harness/heldout/dataset/trailing-country"

describe("trailingCountryRow", () => {
	it("renders the address with its country last and labels every component", () => {
		const row = trailingCountryRow({
			components: { street: "Rruga Bylis", house_number: "16", locality: "Tirane" },
			country: "AL",
			countryName: "Albania",
			source: "osm-al",
			sourceID: "osm-0123",
		})

		expect(row).not.toBeNull()
		expect(row!.raw).toBe("Rruga Bylis 16, Tirane, Albania")
		expect(row!.span_tags).toEqual(["street", "house_number", "locality", "country"])
		expect(row!.raw.slice(row!.span_starts.at(-1), row!.span_ends.at(-1))).toBe("Albania")
		expect(row!.group).toBe("osm-0123")
		expect(endsInLocalityCountry(row!)).toBe(true)
	})
})

describe("commonCountryName", () => {
	const row = (raw: string, name: string) => ({
		raw,
		span_starts: [0, raw.length - name.length],
		span_ends: [raw.length - name.length - 2, raw.length],
		span_tags: ["locality", "country"],
	})

	it("prefers the most frequent Latin-script name, with whitespace collapsed", () => {
		expect(
			commonCountryName([
				row("العين, الإمارات العربية المتحدة", "الإمارات العربية المتحدة"),
				row("العين, الإمارات العربية المتحدة", "الإمارات العربية المتحدة"),
				row("Dubai, United  Arab  Emirates", "United  Arab  Emirates"),
				row("Abu Dhabi, United Arab Emirates", "United Arab Emirates"),
			])
		).toBe("United Arab Emirates")
	})

	it("falls back to another script when no Latin name occurs", () => {
		expect(commonCountryName([row("Երևան, Հայաստան", "Հայաստան")])).toBe("Հայաստան")
		expect(commonCountryName([])).toBeNull()
	})
})

describe("endsInLocalityCountry", () => {
	it("reads the last two spans in text order", () => {
		expect(endsInLocalityCountry({ span_starts: [10, 0], span_tags: ["country", "locality"] })).toBe(true)
		expect(endsInLocalityCountry({ span_starts: [0, 10], span_tags: ["region", "country"] })).toBe(false)
	})
})

describe("firstByTextHash", () => {
	it("keeps one row per group in a fixed order", () => {
		const rows = ["a", "b", "c", "d"].map((raw, i) => ({ raw, group: i < 2 ? "g" : raw }))
		const kept = firstByTextHash(rows, 10)

		expect(kept).toHaveLength(3)
		expect(firstByTextHash(rows.toReversed(), 10)).toEqual(kept)
		expect(firstByTextHash(rows, 1)).toHaveLength(1)
	})
})
