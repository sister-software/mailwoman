/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import type { WOFRecord } from "./wof-json.ts"
import { buildAncestryIndex, extractNameVariants, isCurrentFeature, normalizeNameKey } from "./wof-json.ts"

// `walkFeatures` (filesystem stream) and the private `recordFromFeature` it drives are out of scope
// here; these are the pure object→value / map→map helpers.

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
		population: 5000000, // unrelated key → ignored
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

// --- buildAncestryIndex: pure Map<id, WOFRecord> → Map<id, ancestors[]> ---

function rec(id: number, parent_id: number | null, name = `n${id}`): WOFRecord {
	return { id, parent_id, name, placetype: "locality", country: "US", nameVariants: new Map() }
}

test("buildAncestryIndex: walks parent_id upward, nearest-first, self-excluded", () => {
	// 3 → 2 → 1 (root). 1's parent is null.
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, null)],
		[2, rec(2, 1)],
		[3, rec(3, 2)],
	])
	const index = buildAncestryIndex(byID)
	expect(index.get(3)!.map((r) => r.id)).toEqual([2, 1]) // parent then grandparent
	expect(index.get(2)!.map((r) => r.id)).toEqual([1])
	expect(index.get(1)).toEqual([]) // root has no ancestors
})

test("buildAncestryIndex: stops at the first missing link (partial repo set)", () => {
	// 5's parent 99 isn't in byID → chain ends immediately, degrades gracefully.
	const byID = new Map<number, WOFRecord>([[5, rec(5, 99)]])
	expect(buildAncestryIndex(byID).get(5)).toEqual([])
})

test("buildAncestryIndex: parent_id of null / 0 / negative terminates the walk", () => {
	const byID = new Map<number, WOFRecord>([
		[10, rec(10, null)],
		[11, rec(11, 0)],
		[12, rec(12, -4)], // WOF "only-self" sentinel (e.g. NYC parent_id = -4)
	])
	const index = buildAncestryIndex(byID)
	expect(index.get(10)).toEqual([])
	expect(index.get(11)).toEqual([])
	expect(index.get(12)).toEqual([])
})

test("buildAncestryIndex: a cycle is broken rather than looping forever", () => {
	// Corrupt fixture: 1 → 2 → 1. The guard halts on re-visit.
	const byID = new Map<number, WOFRecord>([
		[1, rec(1, 2)],
		[2, rec(2, 1)],
	])
	const index = buildAncestryIndex(byID)
	// From 1: push 2, then 2's parent is 1 (already in guard) → stop.
	expect(index.get(1)!.map((r) => r.id)).toEqual([2])
	expect(index.get(2)!.map((r) => r.id)).toEqual([1])
})
