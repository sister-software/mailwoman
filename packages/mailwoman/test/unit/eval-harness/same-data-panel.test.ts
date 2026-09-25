/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the same-data panel builder.
 *
 *   The homograph gold alternates between the largest bearer and a smaller one. If the gold were
 *   always the largest bearer, a population prior alone would pass the panel.
 *
 *   Strata draw from disjoint pools, so no place appears on both sides of a paired comparison.
 */

import { loadSameDataDefinition } from "mailwoman/eval-harness/same-data/definition"
import { buildPanel, type GeoNamesCity } from "mailwoman/eval-harness/same-data/panel"
import { beforeAll, describe, expect, it } from "vitest"

function city(
	geonameid: string,
	name: string,
	country: string,
	admin1: string,
	population: number,
	lat = 10,
	lon = 10
): GeoNamesCity {
	return { geonameid, name, asciiname: name, lat, lon, country, admin1, population }
}

/**
 * Builds two same-name places in different countries, plus `uniqueCount` places with unique names.
 */
function corpus(uniqueCount: number): GeoNamesCity[] {
	const rows: GeoNamesCity[] = [
		city("9000001", "Springfield", "US", "IL", 120_000),
		city("9000002", "Springfield", "NZ", "CAN", 60_000),
	]

	for (let index = 0; index < uniqueCount; index++) {
		rows.push(city(`10${String(index).padStart(5, "0")}`, `Unique${index}`, "US", "VT", 60_000))
	}

	return rows
}

const COUNTRY_NAMES = new Map([
	["US", "United States"],
	["NZ", "New Zealand"],
])

const POSTCODES = new Map([
	["US/VT", "05753"],
	["US/CA", "94939"],
	["US/IL", "60453"],
	["NZ/CAN", "8011"],
])

describe("same-data panel builder (#2261)", () => {
	let definition: Awaited<ReturnType<typeof loadSameDataDefinition>>

	beforeAll(async () => {
		definition = await loadSameDataDefinition()
	})

	function build(rows: GeoNamesCity[], gold?: Map<string, number[]>) {
		return buildPanel({
			definition,
			cities: rows,
			countryNames: COUNTRY_NAMES,
			postcodeByAdmin: POSTCODES,
			goldSets: gold ?? new Map(rows.map((row, index) => [row.geonameid, [500 + index]])),
		})
	}

	it("alternates the homograph gold between the largest bearer and a smaller one", () => {
		const { rows } = build(corpus(0))
		const homographs = rows.filter((row) => row.stratum === "homograph_qualified")

		expect(homographs).toHaveLength(1)

		// One eligible name yields one row at index 0, and its gold is the largest bearer.
		expect(homographs[0]!.gold.geonameid).toBe("9000001")
		expect(homographs[0]!.query).toBe("Springfield, United States")
	})

	it("builds a homograph row whose gold is a bearer other than the one being iterated", () => {
		// Two eligible names put a row at index 1, where the rule picks the smaller bearer.
		const rows = [
			...corpus(0),
			city("9000003", "Rutland", "US", "VT", 90_000),
			city("9000004", "Rutland", "NZ", "CAN", 45_000),
		]

		const homographs = build(rows).rows.filter((row) => row.stratum === "homograph_qualified")
		const smallerGold = homographs.filter((row) => row.gold.population < 90_000)

		expect(homographs).toHaveLength(2)
		expect(smallerGold).toHaveLength(1)
	})

	it("counts an ungradeable gold apart from an unbuildable row", () => {
		const rows = corpus(4)
		const gold = new Map(rows.slice(0, 3).map((row, index) => [row.geonameid, [700 + index]]))
		const { census } = build(rows, gold)
		const unambiguous = census.find((entry) => entry.stratum === "unambiguous")!

		expect(unambiguous.droppedUngradeableGold).toBeGreaterThan(0)
		expect(unambiguous.droppedUnbuildable).toBe(0)
	})

	it("draws every stratum from a disjoint pool of geonameids", () => {
		const { rows } = build(corpus(500))
		const seen = new Set(rows.map((row) => row.gold.geonameid))

		expect(seen.size).toBe(rows.length)
	})

	it("withholds the gold only in the registered stratum", () => {
		const { rows } = build(corpus(500))
		const withheld = rows.filter((row) => !row.goldPresent)

		expect(new Set(withheld.map((row) => row.stratum))).toEqual(new Set(["gold_absent"]))
	})

	it("carries the register's license and attribution on every row", () => {
		const { rows } = build(corpus(500))

		for (const row of rows) {
			expect(row.source.license).toBe("CC-BY-4.0")
			expect(row.source.attribution).toBe("GeoNames")
		}
	})

	it("answers identically on a second build from the same inputs", () => {
		expect(build(corpus(300)).rows).toEqual(build(corpus(300)).rows)
	})
})
