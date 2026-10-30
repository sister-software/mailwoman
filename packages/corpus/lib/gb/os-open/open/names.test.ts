/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import {
	createOpenNamesReadStats,
	OPEN_NAMES_COLUMNS,
	populatedPlaceName1,
	readOpenNamesPostcodeCounties,
	readOpenNamesRoads,
} from "#gb/os-open/open/names"

const fixtureCSV = workspacePath("corpus", "fixtures", "gb-os-open", "open-names", "Data", "SE23.csv").toString()

describe("readOpenNamesRoads", () => {
	it("yields both road types, strips the byte-order mark from the first ID, and skips other places", async () => {
		const stats = createOpenNamesReadStats()
		const roads = await Array.fromAsync(readOpenNamesRoads(fixtureCSV, stats))

		expect(roads.map((road) => road.id)).toEqual([
			"osgb4000000000000001",
			"osgb4000000000000002",
			"osgb4000000000000003",
			"osgb4000000000000004",
		])

		expect(roads[0]).toMatchObject({
			name1: "Park Row",
			postcodeDistrict: "LS1",
			populatedPlace: "Leeds",
			districtBorough: "Leeds",
		})

		expect(roads[2]?.populatedPlace).toBe("")
		expect(stats).toEqual({ read: 5, roads: 4, unrequested: 0, malformed: 0 })
	})

	it("yields only the requested ids when given a set", async () => {
		const stats = createOpenNamesReadStats()
		const roads = await Array.fromAsync(readOpenNamesRoads(fixtureCSV, stats, new Set(["osgb4000000000000003"])))

		expect(roads.map((road) => road.name1)).toEqual(["CHURCH LANE"])
		expect(stats.unrequested).toBe(3)
	})
})

describe("readOpenNamesPostcodeCounties", () => {
	it("yields each unit postcode with its county or unitary authority and skips other rows", async () => {
		await using scratch = await temporaryDirectory("open-names-postcodes")
		const csv = scratch.path("TQ75.csv")

		const row = (name1: string, localType: string, county: string) => {
			const cells: string[] = OPEN_NAMES_COLUMNS.map(() => "")

			cells[OPEN_NAMES_COLUMNS.indexOf("NAME1")] = name1
			cells[OPEN_NAMES_COLUMNS.indexOf("LOCAL_TYPE")] = localType
			cells[OPEN_NAMES_COLUMNS.indexOf("COUNTY_UNITARY")] = county

			return cells.join(",")
		}

		await writeLocalTextFile(
			[
				row("ME14 1JH", "Postcode", "Kent"),
				row("Week Street", "Named Road", "Kent"),
				row("ME1 1AA", "Postcode", "Medway"),
			].join("\n") + "\n",
			csv
		)

		const stats = createOpenNamesReadStats()

		await expect(Array.fromAsync(readOpenNamesPostcodeCounties(csv.toString(), stats))).resolves.toEqual([
			{ postcode: "ME14 1JH", countyUnitary: "Kent" },
			{ postcode: "ME1 1AA", countyUnitary: "Medway" },
		])

		expect(stats.read).toBe(3)
	})
})

describe("populatedPlaceName1", () => {
	it("keeps the first name of a bilingual settlement", () => {
		expect(populatedPlaceName1("Stornoway / Steòrnabhagh")).toBe("Stornoway")
		expect(populatedPlaceName1("Abertawe / Swansea")).toBe("Abertawe")
		expect(populatedPlaceName1("Leeds")).toBe("Leeds")
		expect(populatedPlaceName1("")).toBe("")
	})
})
