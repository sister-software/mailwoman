/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Projection-table + census-builder tests. The builder runs against a fixture DB shaped like the WOF
 *   admin DB rather than the shipped 4M-row artifact, so the inclusion rule and the cross-border guard
 *   are asserted on data small enough to read.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { PLACETYPE_PROJECTION, WOF_PLACETYPES, buildPlacetypeCensus, toBaseRates } from "./placetype-census.ts"

/**
 * Build an in-memory DB with the `spr`/`ancestors` shape the census reads, then hand its path-less handle to the
 * builder via a temp file — `node:sqlite` cannot share an `:memory:` DB across connections, and the builder opens its
 * own read-only handle by design.
 */
function fixtureDB(): string {
	const path = `/tmp/census-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.db`
	const db = new DatabaseSync(path)

	db.exec(`CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT)`)
	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER)`)

	const places: Array<[number, string, string, string]> = [
		[1, "London", "locality", "GB"],
		[2, "Shoreditch", "neighbourhood", "GB"],
		[3, "Camden", "borough", "GB"],
		[4, "Quiet Town", "locality", "GB"],
		[5, "Hamlet", "locality", "GB"],
		// A cross-border child: parented to London in the hierarchy but carrying another country.
		[6, "Elsewhere", "neighbourhood", "IE"],
		// A context-only placetype: in the projection table, deliberately uncounted.
		[7, "Greater London", "metroarea", "GB"],
	]

	for (const [id, name, placetype, country] of places) {
		db.prepare(`INSERT INTO spr VALUES (?, ?, ?, ?)`).run(id, name, placetype, country)
	}

	const links: Array<[child: number, ancestor: number]> = [
		[2, 1],
		[3, 1],
		[5, 4],
		[6, 1],
		[7, 1],
	]

	for (const [id, ancestorID] of links) {
		db.prepare(`INSERT INTO ancestors VALUES (?, ?)`).run(id, ancestorID)
	}

	db.close()

	return path
}

describe("PLACETYPE_PROJECTION", () => {
	it("projects the dependent-locality family onto one tag", () => {
		for (const placetype of ["borough", "neighbourhood", "macrohood", "microhood"]) {
			expect(PLACETYPE_PROJECTION[placetype]).toBe("dependent_locality")
		}
	})

	it("covers every placetype in the WOF vocabulary", () => {
		const unmapped = WOF_PLACETYPES.filter((placetype) => !(placetype in PLACETYPE_PROJECTION))

		expect(unmapped).toEqual([])
	})

	it("maps nothing outside the WOF vocabulary", () => {
		const vocabulary = new Set<string>(WOF_PLACETYPES)
		const extra = Object.keys(PLACETYPE_PROJECTION).filter((placetype) => !vocabulary.has(placetype))

		expect(extra).toEqual([])
	})

	it("distinguishes a deliberately-uncounted placetype from an unmapped one", () => {
		// Present with a null value: in the vocabulary, not projected.
		expect("metroarea" in PLACETYPE_PROJECTION).toBe(true)
		expect(PLACETYPE_PROJECTION.metroarea).toBeNull()
		// Absent entirely: the builder must report it rather than count it.
		expect("not_a_wof_placetype" in PLACETYPE_PROJECTION).toBe(false)
	})

	it("projects the sub-venue structures onto venue and unit rather than dropping them", () => {
		expect(PLACETYPE_PROJECTION.building).toBe("venue")
		expect(PLACETYPE_PROJECTION.campus).toBe("venue")
		expect(PLACETYPE_PROJECTION.wing).toBe("unit")
		expect(PLACETYPE_PROJECTION.concourse).toBe("unit")
	})

	it("leaves the multi-span and record placetypes deliberately unprojected", () => {
		// `intersection` is a two-span construct (intersection_a + intersection_b) — no single tag fits.
		expect(PLACETYPE_PROJECTION.intersection).toBeNull()
		// A WOF `address` is a whole address record, not a span role.
		expect(PLACETYPE_PROJECTION.address).toBeNull()
	})
})

describe("buildPlacetypeCensus", () => {
	it("counts children through the projection and applies the inclusion rule", () => {
		const result = buildPlacetypeCensus(fixtureDB(), "GB")
		const parents = result.nodes.map((node) => node.parent).toSorted()

		// "Quiet Town" has only a locality child — no discriminative mass, so it stays out.
		expect(parents).toEqual(["London"])

		const london = result.nodes.find((node) => node.parent === "London")

		// Shoreditch (neighbourhood) + Camden (borough) project onto one tag; the IE child and the metroarea do not count.
		expect(london?.counts.dependent_locality).toBe(2)
		expect(london?.total).toBe(2)
	})

	it("counts the locality backbone into the country totals even where the inclusion rule drops the node", () => {
		const result = buildPlacetypeCensus(fixtureDB(), "GB")

		// Hamlet-under-Quiet-Town is a locality link: excluded from the node table, present in the denominator.
		expect(result.countryTotals.locality).toBe(1)
		expect(result.countryTotals.dependent_locality).toBe(2)
		expect(result.links).toBe(3)
	})

	it("reports no unmapped placetypes on a source the projection table covers", () => {
		expect(buildPlacetypeCensus(fixtureDB(), "GB").unmappedPlacetypes).toEqual([])
	})
})

describe("toBaseRates", () => {
	it("normalizes country totals into shares", () => {
		const rates = toBaseRates({ locality: 900, dependent_locality: 100 })

		expect(rates.locality).toBeCloseTo(0.9, 6)
		expect(rates.dependent_locality).toBeCloseTo(0.1, 6)
	})

	it("returns an empty map for an empty census rather than dividing by zero", () => {
		expect(toBaseRates({})).toEqual({})
	})
})
