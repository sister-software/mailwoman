/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1731 pins. The field is tri-state and the ABSENT states are the contract: a missing sidecar or a place-less entry
 *   must stay ungraded — `false` is a measured contradiction, never a default.
 */

import { describe, expect, it } from "vitest"

import { annotateHierarchyLineage, type HierarchyLineageEntry } from "./hierarchy-lineage.ts"

function entry(placeID?: string): HierarchyLineageEntry {
	return placeID ? { placeID } : {}
}

describe("annotateHierarchyLineage (#1731)", () => {
	it("marks the recorded Astoria chimera: the out-of-lineage region grades false, the winner true", () => {
		// The pre-fix shape: locality resolved to Astoria OREGON (wof:101715747, chain Clatsop → Oregon → US)
		// while the parsed region resolved independently to New York (wof:85688543).
		const locality = entry("wof:101715747")
		const region = entry("wof:85688543")

		annotateHierarchyLineage([locality, region], {
			placeID: "wof:101715747",
			metadata: { ancestors: [{ id: 102_087_589 }, { id: 85_688_513 }, { id: 85_633_793 }] },
		})

		expect(locality.in_winner_lineage).toBe(true)
		expect(region.in_winner_lineage).toBe(false)
	})

	it("vouches for an entry the winner's chain contains", () => {
		const locality = entry("wof:85803821")
		const region = entry("wof:85688543")

		annotateHierarchyLineage([locality, region], {
			placeID: "wof:85803821",
			metadata: { ancestors: [{ id: 85_688_543 }, { id: 85_633_793 }] },
		})

		expect(locality.in_winner_lineage).toBe(true)
		expect(region.in_winner_lineage).toBe(true)
	})

	it("without a sidecar, grades only the winner's own entry and leaves the rest ABSENT", () => {
		const locality = entry("wof:85803821")
		const region = entry("wof:85688543")

		annotateHierarchyLineage([locality, region], { placeID: "wof:85803821", metadata: {} })

		expect(locality.in_winner_lineage).toBe(true)
		expect(region.in_winner_lineage).toBeUndefined()
	})

	it("leaves everything ABSENT with no anchor or a place-less anchor", () => {
		const a = entry("wof:1")
		const b = entry("wof:2")

		annotateHierarchyLineage([a, b], undefined)
		annotateHierarchyLineage([a, b], { metadata: { ancestors: [{ id: 1 }] } })

		expect(a.in_winner_lineage).toBeUndefined()
		expect(b.in_winner_lineage).toBeUndefined()
	})

	it("never grades a place-less entry (the street-register locality unshift)", () => {
		const registerLocality = entry()
		const region = entry("wof:85688543")

		annotateHierarchyLineage([registerLocality, region], {
			placeID: "wof:85803821",
			metadata: { ancestors: [{ id: 85_688_543 }] },
		})

		expect(registerLocality.in_winner_lineage).toBeUndefined()
		expect(region.in_winner_lineage).toBe(true)
	})
})
