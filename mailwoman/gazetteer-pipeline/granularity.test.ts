/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Granularity-ladder tests. The builder runs against a fixture DB shaped like the WOF admin DB
 *   rather than the shipped 4M-row artifact, so the parent-coverage math and the bottoms-out rule
 *   are asserted on data small enough to read.
 */

import { DatabaseSync } from "node:sqlite"

import type { ComponentTag } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"

import type { CountryGranularity, RungMeasurement } from "./granularity.ts"
import {
	DEFAULT_COVERAGE_FLOOR,
	LADDER,
	SUB_LOCALITY_RUNGS,
	bottomsOutAt,
	buildGranularityLadder,
	placetypesForRung,
} from "./granularity.ts"

describe("LADDER", () => {
	it("orders the containment rungs shallowest first", () => {
		expect(LADDER).toEqual(["country", "region", "subregion", "locality", "dependent_locality", "venue", "unit"])
	})

	it("excludes postcode, an orthogonal channel rather than a containment rung", () => {
		expect(LADDER).not.toContain("postcode")
	})
})

describe("placetypesForRung", () => {
	it("derives membership from the projection table rather than a second hand-written list", () => {
		expect(placetypesForRung("dependent_locality")).toEqual(["borough", "macrohood", "microhood", "neighbourhood"])
		expect(placetypesForRung("locality")).toEqual(["localadmin", "locality"])
		expect(placetypesForRung("venue")).toEqual(["building", "campus", "venue"])
	})

	it("returns an empty list for a tag no placetype projects onto", () => {
		expect(placetypesForRung("po_box")).toEqual([])
	})
})

describe("SUB_LOCALITY_RUNGS", () => {
	it("names the rungs measured by parent-coverage rather than presence", () => {
		expect([...SUB_LOCALITY_RUNGS].toSorted()).toEqual(["dependent_locality", "unit", "venue"])
	})
})

/**
 * A fixture DB with the `spr`/`ancestors` shape the ladder reads. `node:sqlite` cannot share an `:memory:` DB across
 * connections and the builder opens its own read-only handle, so this writes a temp file — the same approach
 * `placetype-census.test.ts` uses.
 *
 * Shape: GB has two locality parents (London, Quiet Town). London carries a borough AND a neighbourhood child, which
 * must count as ONE covered parent for dependent_locality, not two. IE has one locality parent and no children at all —
 * a country that bottoms out at locality. One Overture-backfilled locality proves the source split.
 */
function ladderFixtureDB(): string {
	const path = `/tmp/granularity-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.db`
	const db = new DatabaseSync(path)

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER, is_deprecated INTEGER)`
	)

	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER)`)

	const places: Array<[number, string, string, string, number, number]> = [
		[1, "United Kingdom", "country", "GB", 1, 0],
		[2, "London", "locality", "GB", 1, 0],
		[3, "Quiet Town", "locality", "GB", 1, 0],
		[4, "Camden", "borough", "GB", 1, 0],
		[5, "Shoreditch", "neighbourhood", "GB", 1, 0],
		// Deprecated: must not count anywhere.
		[6, "Ghost Hood", "neighbourhood", "GB", 1, 1],
		[7, "Ireland", "country", "IE", 1, 0],
		[8, "Cork", "locality", "IE", 1, 0],
		// An Overture-backfilled locality: counted, but reported separately.
		[8_000_000_000_001, "Backfilled Town", "locality", "IE", 1, 0],
	]

	for (const [id, name, placetype, country, isCurrent, isDeprecated] of places) {
		db.prepare(`INSERT INTO spr VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, placetype, country, isCurrent, isDeprecated)
	}

	// Camden AND Shoreditch both under London — one covered parent, not two.
	const links: Array<[child: number, ancestor: number]> = [
		[4, 2],
		[5, 2],
		[6, 2],
	]

	for (const [id, ancestorID] of links) {
		db.prepare(`INSERT INTO ancestors VALUES (?, ?)`).run(id, ancestorID)
	}

	db.close()

	return path
}

describe("buildGranularityLadder", () => {
	it("counts a parent with two differently-typed children once", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// London has a borough child and a neighbourhood child; both project onto dependent_locality.
		expect(gb?.rungs.dependent_locality?.nodes).toBe(2)
		expect(gb?.rungs.dependent_locality?.parentsCovered).toBe(1)
	})

	it("takes parent-coverage against the country's locality-class node count", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// GB has two locality parents (London, Quiet Town); one carries a dependent locality.
		expect(gb?.localityParents).toBe(2)
		expect(gb?.rungs.dependent_locality?.parentCoverage).toBeCloseTo(0.5, 6)
	})

	it("excludes deprecated rows", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const gb = rows.find((row) => row.country === "GB")

		// "Ghost Hood" is deprecated: 3 neighbourhood-family rows exist, 2 count.
		expect(gb?.rungs.dependent_locality?.nodes).toBe(2)
	})

	it("splits Overture-backfilled rows from real WOF rows", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const ie = rows.find((row) => row.country === "IE")

		expect(ie?.rungs.locality?.nodes).toBe(2)
		expect(ie?.rungs.locality?.overtureBackfilled).toBe(1)
	})

	it("records a measured-and-empty rung as a present zero, not an absent row", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())
		const ie = rows.find((row) => row.country === "IE")

		// IE was measured for dependent_locality and has none. The meaning-of-zero rule: present, zero.
		expect(ie?.rungs.dependent_locality).toBeDefined()
		expect(ie?.rungs.dependent_locality?.nodes).toBe(0)
		expect(ie?.rungs.dependent_locality?.parentCoverage).toBe(0)
	})

	it("returns countries sorted by code", () => {
		const rows = buildGranularityLadder(ladderFixtureDB())

		expect(rows.map((row) => row.country)).toEqual(["GB", "IE"])
	})
})

/**
 * Build a `CountryGranularity` by hand so the bottoms-out rule is tested independently of any SQL.
 */
function granularity(
	country: string,
	spec: Partial<Record<string, { nodes?: number; parentCoverage?: number }>>,
	localityParents = 100
): CountryGranularity {
	const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

	for (const rung of LADDER) {
		const given = spec[rung]

		rungs[rung] = {
			nodes: given?.nodes ?? 0,
			overtureBackfilled: 0,
			parentsCovered: Math.round((given?.parentCoverage ?? 0) * localityParents),
			parentCoverage: given?.parentCoverage ?? 0,
		}
	}

	return { country, localityParents, rungs }
}

describe("bottomsOutAt", () => {
	it("uses node presence at and above the locality backbone", () => {
		const row = granularity("XX", { country: { nodes: 1 }, region: { nodes: 12 } })

		expect(bottomsOutAt(row)).toBe("region")
	})

	it("uses parent-coverage below the backbone", () => {
		const row = granularity("GB", {
			country: { nodes: 1 },
			locality: { nodes: 16_677 },
			dependent_locality: { nodes: 13_177, parentCoverage: 0.33 },
		})

		expect(bottomsOutAt(row)).toBe("dependent_locality")
	})

	it("does not credit a sub-locality rung with nodes but coverage under the floor", () => {
		// A handful of nodes clustered under one parent is not a tier the country reaches.
		const row = granularity("XX", {
			country: { nodes: 1 },
			locality: { nodes: 5000 },
			dependent_locality: { nodes: 40, parentCoverage: 0.01 },
		})

		expect(bottomsOutAt(row)).toBe("locality")
	})

	it("honors a caller-supplied floor", () => {
		const row = granularity("XX", {
			locality: { nodes: 5000 },
			dependent_locality: { nodes: 40, parentCoverage: 0.01 },
		})

		expect(bottomsOutAt(row, 0.005)).toBe("dependent_locality")
	})

	it("returns the deepest qualifying rung, not the first", () => {
		const row = granularity("JP", {
			country: { nodes: 1 },
			locality: { nodes: 43_868 },
			dependent_locality: { nodes: 7759, parentCoverage: 0.08 },
			venue: { nodes: 2000, parentCoverage: 0.2 },
		})

		expect(bottomsOutAt(row)).toBe("venue")
	})

	it("returns null for a country with no live rows at any rung", () => {
		expect(bottomsOutAt(granularity("ZZ", {}, 0))).toBeNull()
	})

	it("defaults the floor to five percent", () => {
		expect(DEFAULT_COVERAGE_FLOOR).toBe(0.05)
	})
})
