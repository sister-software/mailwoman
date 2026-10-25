/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	agreedHierarchyAncestors,
	hierarchyAncestorsInAnyBranch,
	placetypeFromHierarchyKey,
} from "#whosonfirst/hierarchy"

// New York City (85977539) lists five hierarchies that differ only in county.
const NYC = 85_977_539

const NYC_HIERARCHY = [102_082_361, 102_082_377, 102_081_863, 102_083_063, 102_081_779].map((county_id) => ({
	continent_id: 102_191_575,
	country_id: 85_633_793,
	county_id,
	locality_id: NYC,
	region_id: 85_688_543,
}))

test("agreedHierarchyAncestors keeps the levels every hierarchy shares, nearest first, without the record", () => {
	expect(agreedHierarchyAncestors(NYC, NYC_HIERARCHY)).toEqual([85_688_543, 85_633_793, 102_191_575])
	expect(agreedHierarchyAncestors(1, [{ locality_id: 2, region_id: -1, country_id: 3 }])).toEqual([2, 3])
})

test("agreedHierarchyAncestors returns no ancestors for an absent or malformed hierarchy", () => {
	expect(agreedHierarchyAncestors(1, undefined)).toEqual([])
	expect(agreedHierarchyAncestors(1, [])).toEqual([])
	expect(agreedHierarchyAncestors(1, [null])).toEqual([])
})

test("hierarchyAncestorsInAnyBranch takes every ancestor any hierarchy names, with its placetype", () => {
	const ancestors = hierarchyAncestorsInAnyBranch(NYC, NYC_HIERARCHY)

	expect(ancestors.size).toBe(8)
	expect(ancestors.get(102_082_361)).toBe("county")
	expect(ancestors.get(85_688_543)).toBe("region")
	expect(ancestors.has(NYC)).toBe(false)
})

test("placetypeFromHierarchyKey reads only _id keys", () => {
	expect(placetypeFromHierarchyKey("region_id")).toBe("region")
	expect(placetypeFromHierarchyKey("wof:name")).toBeNull()
})
