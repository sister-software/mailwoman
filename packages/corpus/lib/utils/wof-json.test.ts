/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { WOFRecord } from "@mailwoman/corpus/utils/wof-json"
import {
	buildAncestorNameIndex,
	extractNameVariants,
	isCurrentFeature,
	normalizeNameKey,
} from "@mailwoman/corpus/utils/wof-json"
import { expect, test } from "vitest"

// `walkFeatures` (filesystem stream) and the private `recordFromFeature` it drives are out of scope here.
// These are the pure object→value / map→map helpers.

test("isCurrentFeature: 1 and -1 are current, 0 is superseded", () => {
	// WOF + Pelias semantics: -1 ("unknown, treat as active") must count as current.
	expect(isCurrentFeature({ "mz:is_current": 1 })).toBe(true)
	expect(isCurrentFeature({ "mz:is_current": -1 })).toBe(true)
	expect(isCurrentFeature({ "mz:is_current": 0 })).toBe(false)
})

test("isCurrentFeature: string-typed flags are coerced before the comparison", () => {
	expect(isCurrentFeature({ "mz:is_current": "1" })).toBe(true)
	expect(isCurrentFeature({ "mz:is_current": "-1" })).toBe(true)
	expect(isCurrentFeature({ "mz:is_current": "0" })).toBe(false)
})

test("isCurrentFeature: a missing flag defaults to current (1)", () => {
	expect(isCurrentFeature({})).toBe(true)
	expect(isCurrentFeature({ "wof:name": "Somewhere" })).toBe(true)
})

test("extractNameVariants: lifts the first non-empty string from each name:* array", () => {
	const out = extractNameVariants({
		"name:eng_x_preferred": ["Saint Petersburg"],
		"name:rus_x_preferred": ["Санкт-Петербург"],
		"wof:name": "St Petersburg", // not a name:* key → ignored
		population: 5_000_000, // unrelated key → ignored
	})

	expect(out.get("name:eng_x_preferred")).toBe("Saint Petersburg")
	expect(out.get("name:rus_x_preferred")).toBe("Санкт-Петербург")
	expect(out.has("wof:name")).toBe(false)
	expect(out.size).toBe(2)
})

test("extractNameVariants: accepts bare-string values and trims whitespace", () => {
	const out = extractNameVariants({
		"name:fra_x_preferred": "  Paris  ",
		"name:deu_x_preferred": ["  München  "],
	})

	expect(out.get("name:fra_x_preferred")).toBe("Paris")
	expect(out.get("name:deu_x_preferred")).toBe("München")
})

test("extractNameVariants: skips empty / whitespace-only / non-string values", () => {
	const out = extractNameVariants({
		"name:eng_x_preferred": [""], // empty string in array
		"name:fra_x_preferred": "   ", // whitespace-only bare string
		"name:rus_x_preferred": [], // empty array
		"name:deu_x_preferred": [null, 42, "Berlin"], // first usable string wins
	})

	expect(out.has("name:eng_x_preferred")).toBe(false)
	expect(out.has("name:fra_x_preferred")).toBe(false)
	expect(out.has("name:rus_x_preferred")).toBe(false)
	expect(out.get("name:deu_x_preferred")).toBe("Berlin")
	expect(out.size).toBe(1)
})

test("extractNameVariants: empty properties → empty map", () => {
	expect(extractNameVariants({}).size).toBe(0)
})

test("normalizeNameKey: both ':' and '_' become '-' for source_id safety", () => {
	expect(normalizeNameKey("name:eng_x_colloquial")).toBe("name-eng-x-colloquial")
	expect(normalizeNameKey("name:fra")).toBe("name-fra")
	expect(normalizeNameKey("plain")).toBe("plain")
})

// These cases cover buildAncestorNameIndex's pure record-map-to-name-map transform.

function rec(id: number, parent_id: number | null, name = `n${id}`, placetype = "locality"): WOFRecord {
	return { id, parent_id, name, placetype, country: "US", nameVariants: new Map() }
}

/**
 * The placetype-to-tag map the adapters pass, reduced to the three tags the index resolves.
 */
const tagOf = (placetype: string): string | null => (placetype === "postalcode" ? "postcode" : placetype)

test("buildAncestorNameIndex: resolves the nearest ancestor's name per tag, excluding the record itself", () => {
	// 3 (postcode) → 2 (locality) → 1 (region, root).
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, null, "Oregon", "region")],
		[2, rec(2, 1, "Portland", "locality")],
		[3, rec(3, 2, "97214", "postalcode")],
	])

	const index = buildAncestorNameIndex(byID, tagOf)

	expect(index.get(3)).toEqual({ locality: "Portland", region: "Oregon" })
	expect(index.get(2)).toEqual({ region: "Oregon" })
	// The root's own region name is not its own ancestor.
	expect(index.get(1)).toEqual({})
})

test("buildAncestorNameIndex: the nearest ancestor carrying a tag wins over a farther one", () => {
	// Two localities on one chain: 3 → 2 (Beaverton) → 1 (Portland).
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, null, "Portland", "locality")],
		[2, rec(2, 1, "Beaverton", "locality")],
		[3, rec(3, 2, "97005", "postalcode")],
	])

	expect(buildAncestorNameIndex(byID, tagOf).get(3)).toEqual({ locality: "Beaverton" })
})

test("buildAncestorNameIndex: stops at the first missing link (partial repo set)", () => {
	// 5's parent 99 is absent from byID, so the walk ends before resolving any tag.
	const byID = new Map<number, WOFRecord>([[5, rec(5, 99)]])

	expect(buildAncestorNameIndex(byID, tagOf).get(5)).toEqual({})
})

test("buildAncestorNameIndex: parent_id of null / 0 / negative terminates the walk", () => {
	const byID = new Map<number, WOFRecord>([
		[10, rec(10, null)],
		[11, rec(11, 0)],
		[12, rec(12, -4)], // WOF "only-self" sentinel (e.g. NYC parent_id = -4)
	])

	const index = buildAncestorNameIndex(byID, tagOf)

	expect(index.get(10)).toEqual({})
	expect(index.get(11)).toEqual({})
	expect(index.get(12)).toEqual({})
})

test("buildAncestorNameIndex: a cycle is broken rather than looping forever", () => {
	// Corrupt fixture: 1 → 2 → 1.
	// The guard halts on re-visit.
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, 2, "Oregon", "region")],
		[2, rec(2, 1, "Portland", "locality")],
	])

	const index = buildAncestorNameIndex(byID, tagOf)

	// From 1: read 2, then 2's parent is 1 and the guard stops the walk.
	expect(index.get(1)).toEqual({ locality: "Portland" })
	expect(index.get(2)).toEqual({ region: "Oregon" })
})

test("buildAncestorNameIndex: a placetype outside the three tags contributes no name", () => {
	// 3 → 2 (county maps to `subregion`) → 1 (region).
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, null, "Oregon", "region")],
		[2, rec(2, 1, "Multnomah County", "county")],
		[3, rec(3, 2, "Portland", "locality")],
	])

	expect(
		buildAncestorNameIndex(byID, (placetype) => (placetype === "county" ? "subregion" : placetype)).get(3)
	).toEqual({ region: "Oregon" })
})
