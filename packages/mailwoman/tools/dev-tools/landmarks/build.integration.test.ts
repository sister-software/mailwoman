/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { VitalPlace } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/inventory"
import { LandmarkSqliteLookup } from "@mailwoman/resolver-wof-sqlite/landmark"
import { afterAll, describe, expect, it } from "vitest"

import { airportRows, readAirportCodes } from "./airport-codes.ts"
import { buildLandmarkDatabase, landmarkRows } from "./build.ts"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const SITE = "Q-site"
const TOWN = "Q-town"
const ROAD = "Q-road"

const roots = { [SITE]: ["Q570116"], [TOWN]: ["Q486972"], [ROAD]: ["Q34442"] }

function place(overrides: Partial<VitalPlace> & Pick<VitalPlace, "qid" | "classes">): VitalPlace {
	return {
		qrank: 1,
		countries: [],
		countryCodes: ["US"],
		coordinate: { lat: 42.21, lon: -83.35 },
		population: null,
		sitelinks: 39,
		labels: { en: "Detroit Metropolitan Wayne County Airport", fr: "Aéroport de Détroit" },
		aliases: { en: ["DTW", "Detroit Metro Airport"] },
		...overrides,
	}
}

describe("landmarkRows", () => {
	it("marks the English name primary and a translation or alias secondary", () => {
		const rows = landmarkRows(place({ qid: "Q1", classes: [SITE] }), roots)
		const primaryOf = (key: string) => rows.find((row) => row.name_key === key)?.is_primary

		expect(primaryOf("detroit metropolitan wayne county airport")).toBe(1)
		expect(primaryOf("detroit metro airport")).toBe(0)
		expect(rows.find((row) => row.name_key === "dtw")?.code).toBe("DTW")
	})

	it("writes a settlement as a settlement and leaves out a road", () => {
		expect(landmarkRows(place({ qid: "Q2", classes: [TOWN] }), roots)[0]?.kind).toBe("settlement")
		expect(landmarkRows(place({ qid: "Q3", classes: [ROAD] }), roots)).toEqual([])
	})

	it("leaves out a place with no coordinate", () => {
		expect(landmarkRows(place({ qid: "Q4", classes: [SITE], coordinate: null }), roots)).toEqual([])
	})
})

describe("readAirportCodes", () => {
	const literal = (value: string) => ({ type: "literal", value })

	const answer = (iata: string, coord = "Point(-122.375 37.618888888)") => ({
		item: { type: "uri", value: "http://www.wikidata.org/entity/Q8688" },
		itemLabel: literal("San Francisco International Airport"),
		iata: literal(iata),
		coord: literal(coord),
		links: literal("59"),
		cc: literal("US"),
	})

	it("reads an airport once and leaves out an unreadable coordinate", () => {
		const airports = readAirportCodes({
			results: { bindings: [answer("SFO"), answer("SFO"), answer("XXX", "not a point")] },
		})

		expect(airports).toEqual([
			{
				qid: "Q8688",
				name: "San Francisco International Airport",
				iata: "SFO",
				lat: 37.618888888,
				lon: -122.375,
				sitelinks: 59,
				country: "US",
			},
		])
	})

	it("ranks an official code as a primary name", () => {
		const [code] = airportRows({
			qid: "Q1",
			name: "An Airport",
			iata: "SFO",
			lat: 1,
			lon: 2,
			sitelinks: 3,
			country: "US",
		})

		expect(code).toMatchObject({ name_key: "sfo", code: "SFO", is_primary: 1 })
	})
})

describe("LandmarkSqliteLookup", () => {
	it("reads an alias, and reads a code only in its own case", async () => {
		const dir = fixtures.use(await temporaryDirectory("landmarks-")).path
		const out = dir("landmarks.db")

		await buildLandmarkDatabase([place({ qid: "Q1", classes: [SITE] })], roots, out)

		using lookup = new LandmarkSqliteLookup(out)

		expect(lookup.find("Detroit Metro Airport")[0]?.qid).toBe("Q1")
		expect(lookup.find("DTW")[0]).toMatchObject({ primary: false, code: true })
		expect(lookup.find("Detroit Metro Airport")[0]?.code).toBe(false)
		expect(lookup.find("Dtw")).toEqual([])
		expect(lookup.find("Nowhere")).toEqual([])
	})
})
