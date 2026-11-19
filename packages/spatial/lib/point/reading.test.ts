// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { HandlerMap, KindsOf } from "@mailwoman/recognizer"
import { CoordinatesKind, coordinates } from "@mailwoman/recognizer/coordinates"
import { IdentifiersKind, identifiers } from "@mailwoman/recognizer/identifiers"
import { SpatialKind, spatial } from "@mailwoman/recognizer/spatial"
import { describe, expect, expectTypeOf, test } from "vitest"

import { decodePlusCode, recoverNearestPlusCode } from "#open-location-code"
import { type PointQueryKind, pointFromText, recognizePointQuery } from "#point/reading"
import { coordinatePairText, POINT_QUERY_DESCRIPTIONS } from "#point/text"

interface FrozenCase {
	category: string
	input: string
	expected: Record<string, unknown> | null
}

const fixture = await readLocalJSONFile<{ cases: FrozenCase[] }>(
	workspacePath("spatial", "data", "fixtures", "point-query-frozen.fixture.json").toString()
)

describe("the frozen readings of the deleted parsePointQuery", () => {
	test("the fixture covers every kind of point and every class of change", () => {
		const categories = new Set(fixture.cases.map((entry) => entry.category))

		expect([...categories].toSorted()).toEqual([
			"agreed:coordinates",
			"agreed:geohash",
			"agreed:h3",
			"agreed:plus_code_full",
			"agreed:plus_code_short",
			"agreed:wof",
			"hemisphere_after_complete_dms_group",
			"legacy_only",
			"neither",
			"recognize_only",
		])
	})

	test.each(["agreed", "legacy_only", "recognize_only", "hemisphere_after_complete_dms_group", "neither"])(
		"reads every %s case as recorded",
		(group) => {
			const cases = fixture.cases.filter((entry) => entry.category.split(":")[0] === group)

			expect(cases.length).toBeGreaterThan(0)

			for (const { input, expected } of cases) {
				// The fixture is JSON, and JSON writes a negative zero as `0`.
				const reading = parseJSONStrict<{ kind?: string } | null>(stringifyJSON(pointFromText(input)))

				// The deleted parser read neither a DIGIPIN nor a GeoJSON point, so a text that it left unread may be one.
				if (!expected && reading?.kind === "digipin") {
					expect(input).toMatch(/^[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{4}$/iu)

					continue
				}

				if (expected) {
					expect(reading, input).toMatchObject(expected)
				} else {
					expect(reading, input).toBeNull()
				}
			}
		}
	)
})

test("coordinatePairText writes the pair the reader reads back", () => {
	expect(coordinatePairText(48.8584, 2.2945)).toBe("48.858400, 2.294500")

	expect(pointFromText(coordinatePairText(-33.865, 151.21))).toMatchObject({
		kind: "coordinates",
		latitude: -33.865,
		longitude: 151.21,
		order: "lat_lon",
	})
})

describe("recognizePointQuery", () => {
	test("reads decimal pairs latitude first, in every common spelling", () => {
		const paris = { kind: "coordinates", latitude: 48.8584, longitude: 2.2945, order: "lat_lon" }

		for (const text of [
			"48.8584, 2.2945",
			"48.8584,2.2945",
			"48.8584 2.2945",
			"48.8584 ; 2.2945",
			"geo:48.8584,2.2945",
			"geo:48.8584,2.2945,35;u=10",
			"@48.8584,2.2945,17z",
			"lat 48.8584 lon 2.2945",
			"latitude: 48.8584, longitude: 2.2945",
		]) {
			expect(recognizePointQuery(text), text).toMatchObject(paris)
		}
	})

	test("names the generated kind the reading came from", () => {
		expect(recognizePointQuery("geo:48.8584,2.2945")).toMatchObject({ recognized: "coordinate.geo_uri" })
		expect(recognizePointQuery("@48.8584,2.2945,17z")).toMatchObject({ recognized: "coordinate.maps_segment" })
		expect(recognizePointQuery("lat 48.8584 lon 2.2945")).toMatchObject({ recognized: "coordinate.labeled_pair" })
	})

	test("reads hemisphere letters, degrees-minutes-seconds and the longitude-first fallback", () => {
		expect(recognizePointQuery("2.2945E, 48.8584N")).toMatchObject({
			latitude: 48.8584,
			longitude: 2.2945,
			order: "lon_lat",
		})

		expect(recognizePointQuery("139.6917, 35.6895")).toMatchObject({
			latitude: 35.6895,
			longitude: 139.6917,
			order: "lon_lat",
		})

		const dms = recognizePointQuery(`38°53'51.72"N 77°2'11.40"W`)

		if (dms?.kind !== "coordinates") throw new Error("the DMS pair did not read as coordinates")

		expect(dms.latitude).toBeCloseTo(38.8977, 4)
		expect(dms.longitude).toBeCloseTo(-77.0365, 4)

		expect(recognizePointQuery("200, 300")).toBeNull()
		expect(recognizePointQuery("lng=2.2945, lng=48.8584")).toBeNull()
	})

	test("a hemisphere letter after a complete degrees-minutes-seconds group is a hemisphere", () => {
		const south = recognizePointQuery("12°30′20S, 5E")

		if (south?.kind !== "coordinates") throw new Error("the pair did not read as coordinates")

		expect(south.latitude).toBeCloseTo(-(12 + 30 / 60 + 20 / 3600), 9)
		expect(south.longitude).toBe(5)
		expect(south.order).toBe("lat_lon")

		// A lowercase `s` and the word marks keep the seconds mark.
		expect(recognizePointQuery("12°30′20s, 5E")).toMatchObject({ latitude: 12 + 30 / 60 + 20 / 3600 })
		expect(recognizePointQuery("12d 30m 20s, 5E")).toMatchObject({ latitude: 12 + 30 / 60 + 20 / 3600 })
	})

	test("leaves addresses and bare numbers to the classifier", () => {
		for (const text of [
			"",
			"90210",
			"12 34",
			"10 Downing Street, London",
			"1600 Pennsylvania Ave NW, Washington, DC 20500",
			"5 Hauptstraße, Berlin, Berlin 10115",
			"Chicago, IL",
			"Moscow, Russia",
			"Apt 4, 12 Main St",
			"12345 Main Street",
			"Managua, VFQ6+92P",
			"VFQ6+92P Managua",
		]) {
			expect(recognizePointQuery(text), text).toBeNull()
		}
	})

	test("an embedded or rejected recognition does not become a point", () => {
		// `4, 12` is a valid pair inside the address.
		expect(recognizePointQuery("Apt 4, 12 Main St")).toBeNull()
		// A rejected recognition has no payload to read.
		expect(recognizePointQuery("geo:48.8584,2.2945;crs=Moon-2011")).toBeNull()
		expect(recognizePointQuery("geo:1,2,35;u=-1")).toBeNull()
		expect(recognizePointQuery("VFQ+92P")).toBeNull()
	})

	test("the caller trims, because the grammars admit no outer white space", () => {
		expect(recognizePointQuery(" 48.8584, 2.2945 ")).toBeNull()
		expect(recognizePointQuery(" 48.8584, 2.2945 ".trim())).toMatchObject({ kind: "coordinates" })
	})

	test("reads plus codes, full and short", () => {
		expect(recognizePointQuery("764MVFQ6+92P")).toMatchObject({ kind: "plus_code", code: "764MVFQ6+92P", full: true })
		expect(recognizePointQuery("vfq6+92p")).toMatchObject({ kind: "plus_code", code: "VFQ6+92P", full: false })
	})

	test("reads H3 cells, geohashes and Who's On First ids", () => {
		expect(recognizePointQuery("8928308280FFFFF")).toMatchObject({ kind: "h3", cell: "8928308280fffff" })
		expect(recognizePointQuery("h3:8928308280fffff")).toMatchObject({ kind: "h3", cell: "8928308280fffff" })
		expect(recognizePointQuery("geohash:dqcjqcp")).toMatchObject({ kind: "geohash", hash: "dqcjqcp" })
		expect(recognizePointQuery("gh:EZS42")).toMatchObject({ kind: "geohash", hash: "ezs42" })
		expect(recognizePointQuery("ezs42")).toBeNull()

		expect(recognizePointQuery("wof:1880762729")).toMatchObject({ kind: "wof", id: 1_880_762_729 })
		expect(recognizePointQuery("WOF 85633793")).toMatchObject({ kind: "wof", id: 85_633_793 })

		expect(recognizePointQuery("https://spelunker.whosonfirst.org/id/85633793/")).toMatchObject({
			kind: "wof",
			id: 85_633_793,
		})

		expect(recognizePointQuery("wof:0")).toBeNull()
	})

	test("a DIGIPIN in the display form is a point and a bare one is ambiguous", () => {
		expect(recognizePointQuery("39J-49L-L8T4")).toMatchObject({ kind: "digipin", code: "39J49LL8T4" })

		expect(recognizePointQuery("39J49LL8T4")).toEqual({
			kind: "not_a_point",
			recognized: "digipin.compact",
			reason: "ambiguous_without_prefix",
		})

		expect(pointFromText("39J49LL8T4")).toBeNull()
	})

	test("a display-form DIGIPIN of only digits is also a phone number, so it is not a point", () => {
		// The validator still accepts it as a well-formed DIGIPIN.
		expect(recognizePointQuery("234-567-8923")).toEqual({
			kind: "not_a_point",
			recognized: "digipin.display",
			reason: "digit_group",
		})

		expect(pointFromText("234-567-8923")).toBeNull()
		// A display form with one letter of the alphabet is a point.
		expect(pointFromText("39J-49L-L8T4")).toMatchObject({ kind: "digipin", code: "39J49LL8T4" })
		expect(pointFromText("234-567-89T3")).toMatchObject({ kind: "digipin", code: "234567" + "89T3" })
	})

	test("a plus code reads as a full or a short brand that a decoder can take", () => {
		const full = pointFromText("764MVFQ6+92P")
		const short = pointFromText("VFQ6+92P")

		if (full?.kind !== "plus_code" || !full.full || short?.kind !== "plus_code" || short.full) {
			throw new Error("the plus codes did not read as a full code and a short code")
		}

		expect(decodePlusCode(full.code).lat).toBeCloseTo(12.8884, 3)
		expect(recoverNearestPlusCode(short.code, 12.88687, -86.53903).lat).toBeCloseTo(12.8884625, 6)
	})

	test("a GeoJSON Point is the point and every other GeoJSON object names no single position", () => {
		expect(recognizePointQuery(`{"type":"Point","coordinates":[2.2945,48.8584]}`)).toMatchObject({
			kind: "geojson_point",
			latitude: 48.8584,
			longitude: 2.2945,
		})

		expect(recognizePointQuery(`{"type":"LineString","coordinates":[[0,0],[1,1]]}`)).toEqual({
			kind: "not_a_point",
			recognized: "geojson.object",
			reason: "names_no_position",
		})
	})

	test("a Census GEOID and a GNIS id are recognized and are not a point query", () => {
		expect(recognizePointQuery("06075")).toEqual({
			kind: "not_a_point",
			recognized: "census.geoid_county",
			reason: "names_no_position",
		})

		expect(recognizePointQuery("gnis:1234567")).toEqual({
			kind: "not_a_point",
			recognized: "gnis.reference",
			reason: "names_no_position",
		})

		expect(pointFromText("06075")).toBeNull()
		expect(pointFromText("gnis:1234567")).toBeNull()
	})

	test("a text that two shapes cover reads as the point, not as the identifier that is not one", () => {
		// `800000000000000` is a Census block GEOID shape and an H3 cell shape.
		// The family declares that overlap.
		expect(recognizePointQuery("8928308280fffff")?.kind).toBe("h3")
		expect(recognizePointQuery("890000000000000")?.kind).toBe("h3")
	})
})

describe("the handler map", () => {
	const families = [coordinates, spatial, identifiers] as const

	test("has a kind for every shape of the three families", () => {
		expectTypeOf<KindsOf<typeof families>>().toEqualTypeOf<PointQueryKind>()

		const kinds = [
			...Object.values(CoordinatesKind),
			...Object.values(SpatialKind),
			...Object.values(IdentifiersKind),
		].toSorted()

		expect(Object.keys(POINT_QUERY_DESCRIPTIONS).toSorted()).toEqual(kinds)
		expect(kinds).toHaveLength(23)
	})

	test("refuses a map that omits a kind of a composed family", () => {
		const missing = {
			"coordinate.decimal_pair": () => 1,
			"coordinate.decimal_pair_spaced": () => 1,
			"coordinate.dms_pair": () => 1,
			"coordinate.dms_pair_spaced": () => 1,
			"coordinate.geo_uri": () => 1,
			"coordinate.labeled_pair": () => 1,
			"coordinate.maps_segment": () => 1,
			"plus_code.token": () => 1,
			"digipin.compact": () => 1,
			"digipin.display": () => 1,
			"geojson.object": () => 1,
			"census.geoid_block": () => 1,
			"census.geoid_block_group": () => 1,
			"census.geoid_county": () => 1,
			"census.geoid_state": () => 1,
			"census.geoid_tract": () => 1,
			"geohash.prefixed": () => 1,
			"gnis.reference": () => 1,
			"gnis.summary_url": () => 1,
			"h3.cell": () => 1,
			"h3.prefixed_cell": () => 1,
			"wof.reference": () => 1,
			// @ts-expect-error `wof.spelunker_url` has no handler
		} satisfies HandlerMap<typeof families>

		expect(Object.keys(missing)).toHaveLength(22)
	})
})
