// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	isSupersededRecord,
	repointRecordReferences,
	type ReferenceResolution,
	roundRecordGeometry,
	SlimSkip,
	wofGeometryHash,
} from "#tools/pipeline/wof/slim"

/**
 * A record in the WOF layout: one property per line, then the geometry on one line.
 */
function record(geometry: object | string, extra: Record<string, unknown> = {}): string {
	const properties = { "wof:id": 1, "geom:latitude": 50.39180349824032, "wof:geomhash": "0".repeat(32), ...extra }
	const lines = Object.entries(properties).map(([key, value]) => `    ${stringifyJSON(key)}:${stringifyJSON(value)}`)
	const geometryText = typeof geometry === "string" ? geometry : stringifyJSON(geometry)

	return `{\n  "id": 1,\n  "type": "Feature",\n  "properties": {\n${lines.join(",\n")}\n  },\n  "bbox": [\n    -90.2,\n    38.4\n],\n  "geometry": ${geometryText}\n}\n`
}

/**
 * A polygon as an older exporter wrote it: `-90.18399100000001` is the same number as `-90.183991`
 * printed with extra digits, and `38.44869712345678` is a value with 14 decimal places.
 */
const NOISY =
	'{"type":"Polygon","coordinates":[[[-90.184775,38.448702],[-90.18399100000001,38.44869712345678],' +
	"[-90.17759599999999,38.448692],[-90.184775,38.448702]]]}"

describe("roundRecordGeometry", () => {
	it("rounds noisy coordinates to six places and rewrites the geometry hash", () => {
		const result = roundRecordGeometry(record(NOISY))

		expect(result.kind).toBe("rounded")

		if (result.kind !== "rounded") return

		const parsed = parseJSONStrict<{
			geometry: { type: string; coordinates: number[][][] }
			properties: Record<string, unknown>
		}>(result.text)

		expect(parsed.geometry.coordinates[0]![1]).toEqual([-90.183991, 38.448697])
		expect(parsed.geometry.coordinates[0]![2]).toEqual([-90.177596, 38.448692])
		expect(result.text).toContain("[-90.183991,38.448697],[-90.177596,38.448692]")
		expect(parsed.properties["wof:geomhash"]).toBe(wofGeometryHash(parsed.geometry))
		// Three tokens change: two printed with extra digits and one with 14 decimal places.
		expect(result.coordinates).toBe(3)
	})

	it("keeps every property byte, including over-precise property values", () => {
		const original = record(NOISY)
		const result = roundRecordGeometry(original)

		if (result.kind !== "rounded") throw new Error(`expected a rounding, got ${result.kind}`)

		const strip = (text: string) =>
			text.replace(/^ {2}"geometry":.*$/m, "").replace(/"wof:geomhash":"[0-9a-f]{32}"/, "")

		expect(strip(result.text)).toBe(strip(original))
		expect(result.text).toContain('"geom:latitude":50.39180349824032')
	})

	it("keeps the geometry's key order", () => {
		const coordinatesFirst = NOISY.replace('"type":"Polygon",', "").replace(/\}$/, ',"type":"Polygon"}')
		const result = roundRecordGeometry(record(coordinatesFirst))

		if (result.kind !== "rounded") throw new Error(`expected a rounding, got ${result.kind}`)

		expect(result.text).toMatch(/^ {2}"geometry": \{"coordinates":/m)
	})

	it("leaves a record already at six places unchanged", () => {
		expect(roundRecordGeometry(record({ type: "Point", coordinates: [-90.184775, 38.448702] }))).toEqual({
			kind: "unchanged",
		})
	})

	it("skips a superseded record, which the removal step deletes", () => {
		expect(roundRecordGeometry(record(NOISY, { "wof:superseded_by": [2] }))).toEqual({
			kind: "skipped",
			reason: SlimSkip.Superseded,
		})
	})

	it("skips a ring whose neighboring vertices would become equal", () => {
		const close = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[1.0000001, 1],
					[1.0000002, 1],
					[0, 1],
					[0, 0],
				],
			],
		}

		expect(roundRecordGeometry(record(close))).toEqual({ kind: "skipped", reason: SlimSkip.CollapsedVertex })
	})

	it("skips a geometry written across several lines rather than change the file's layout", () => {
		const pretty = record(prettyJSON(parseJSONStrict(NOISY)).trimEnd())

		expect(roundRecordGeometry(pretty)).toEqual({ kind: "skipped", reason: SlimSkip.MultiLineGeometry })
	})
})

describe("wofGeometryHash", () => {
	it("hashes the geometry with coordinates before type, the form the WOF exporter writes", () => {
		// `whosonfirst-data-admin-gb` record 101750297 stores this hash for its geometry.
		const geometry = { type: "Point", coordinates: [1, 2] }

		expect(wofGeometryHash(geometry)).toBe(wofGeometryHash({ coordinates: [1, 2], type: "Point" }))
		expect(wofGeometryHash(geometry)).toMatch(/^[0-9a-f]{32}$/)
	})
})

describe("isSupersededRecord", () => {
	it("reads a non-empty wof:superseded_by as superseded and an empty one as current", () => {
		expect(isSupersededRecord({ properties: { "wof:superseded_by": [5] } })).toBe(true)
		expect(isSupersededRecord({ properties: { "wof:superseded_by": [] } })).toBe(false)
		expect(isSupersededRecord({ properties: {} })).toBe(false)
	})
})

describe("repointRecordReferences", () => {
	/**
	 * A locality in the WOF exporter's layout whose region, 85675763, was superseded by 1360701001.
	 */
	const purzanMohri = (belongsTo: number[] = [102_191_569, 85_632_659, 85_675_763, 1_108_692_295]): string =>
		[
			"{",
			'  "id": 1193013231,',
			'  "type": "Feature",',
			'  "properties": {',
			'    "wof:belongsto":[',
			belongsTo.map((id, index) => `        ${id}${index < belongsTo.length - 1 ? "," : ""}`).join("\n"),
			"    ],",
			'    "wof:hierarchy":[',
			"        {",
			'            "continent_id":102191569,',
			'            "country_id":85632659,',
			'            "county_id":1108692295,',
			'            "locality_id":1193013231,',
			'            "region_id":85675763',
			"        }",
			"    ],",
			'    "wof:id":1193013231,',
			'    "wof:name":"Purzan Mohri",',
			'    "wof:parent_id":85675763,',
			'    "wof:placetype":"locality"',
			"},",
			'  "geometry": {"coordinates":[71.0,33.0],"type":"Point"}',
			"}",
			"",
		].join("\n")

	const khyber: ReferenceResolution = { kind: "replace", id: 1_360_701_001, placetype: "region" }
	const successorOf = (id: number) => (id === 85_675_763 ? khyber : null)
	const propertiesOf = (text: string) => parseJSONStrict<{ properties: Record<string, unknown> }>(text).properties
	const hierarchyOf = (text: string) => propertiesOf(text)["wof:hierarchy"] as Array<Record<string, number>>

	it("replaces the removed region in the parent, the hierarchy and belongsto, and changes no other line", () => {
		const before = purzanMohri()
		const result = repointRecordReferences(before, successorOf)

		expect(result).toMatchObject({ kind: "repointed", replaced: 3, moved: 0, removed: 0 })

		if (result.kind !== "repointed") return

		const changed = (text: string) => TextSpliterator.from(text, { trim: false, skipEmpty: false }).toArray()
		const diff = changed(before).flatMap((line, index) => (line === changed(result.text)[index] ? [] : [line.trim()]))

		expect(diff).toEqual(["85675763,", '"region_id":85675763', '"wof:parent_id":85675763,'])

		const properties = parseJSONStrict<{ properties: Record<string, unknown> }>(result.text).properties

		expect(properties["wof:parent_id"]).toBe(1_360_701_001)
		expect(properties["wof:belongsto"]).toEqual([102_191_569, 85_632_659, 1_360_701_001, 1_108_692_295])

		expect(properties["wof:hierarchy"]).toEqual([
			{
				continent_id: 102_191_569,
				country_id: 85_632_659,
				county_id: 1_108_692_295,
				locality_id: 1_193_013_231,
				region_id: 1_360_701_001,
			},
		])
	})

	it("moves a hierarchy value to the key of a successor of another placetype", () => {
		const result = repointRecordReferences(purzanMohri(), (id) =>
			id === 85_675_763 ? { kind: "replace", id: 1_360_701_001, placetype: "macroregion" } : null
		)

		expect(result).toMatchObject({ kind: "repointed", moved: 1 })

		if (result.kind !== "repointed") return

		expect(propertiesOf(result.text)["wof:parent_id"]).toBe(1_360_701_001)

		expect(hierarchyOf(result.text)[0]).toEqual({
			continent_id: 102_191_569,
			country_id: 85_632_659,
			county_id: 1_108_692_295,
			locality_id: 1_193_013_231,
			macroregion_id: 1_360_701_001,
		})
	})

	it("drops the old key when the branch already states the successor's level", () => {
		// The removed region's successor is a county, and the branch already has its own county.
		const result = repointRecordReferences(purzanMohri(), (id) =>
			id === 85_675_763 ? { kind: "replace", id: 1_360_701_001, placetype: "county" } : null
		)

		if (result.kind !== "repointed") throw new Error("expected a repointed record")

		expect(result.removed).toBe(1)
		expect(hierarchyOf(result.text)[0]).toMatchObject({ county_id: 1_108_692_295 })
		expect(hierarchyOf(result.text)[0]).not.toHaveProperty("region_id")
	})

	it("removes a reference with no successor and leaves an unknown parent", () => {
		const result = repointRecordReferences(purzanMohri(), (id) => (id === 85_675_763 ? { kind: "remove" } : null))

		expect(result).toMatchObject({ kind: "repointed", replaced: 0, removed: 3 })

		if (result.kind !== "repointed") return

		expect(propertiesOf(result.text)["wof:parent_id"]).toBe(-1)
		expect(propertiesOf(result.text)["wof:belongsto"]).toEqual([102_191_569, 85_632_659, 1_108_692_295])
		expect(hierarchyOf(result.text)[0]).not.toHaveProperty("region_id")
	})

	it("drops the removed ID from belongsto when the successor is already listed", () => {
		const result = repointRecordReferences(
			purzanMohri([102_191_569, 85_632_659, 85_675_763, 1_360_701_001]),
			successorOf
		)

		if (result.kind !== "repointed") throw new Error("expected a repointed record")

		expect(propertiesOf(result.text)["wof:belongsto"]).toEqual([102_191_569, 85_632_659, 1_360_701_001])
	})

	it("never makes a record its own parent or ancestor when the removed ID's successor is the record", () => {
		// The removed region's successor is the locality itself, as a merged commune's successor can be.
		const result = repointRecordReferences(purzanMohri(), (id) =>
			id === 85_675_763 ? { kind: "replace", id: 1_193_013_231, placetype: "locality" } : null
		)

		expect(result).toMatchObject({ kind: "repointed", replaced: 0, removed: 3 })

		if (result.kind !== "repointed") return

		expect(propertiesOf(result.text)["wof:parent_id"]).toBe(-1)
		expect(hierarchyOf(result.text)[0]).not.toHaveProperty("region_id")
		expect(propertiesOf(result.text)["wof:belongsto"]).toEqual([102_191_569, 85_632_659, 1_108_692_295])
	})

	it("keeps the layout of an exporter that indents by two and puts a space after each colon", () => {
		// The whosonfirst-data-admin-gb layout, from Rochester (WOF 101750331).
		const before = [
			"{",
			'  "id": 101750331,',
			'  "type": "Feature",',
			'  "properties": {',
			'    "wof:belongsto": [',
			"      1360698565,",
			"      85633159",
			"    ],",
			'    "wof:hierarchy": [',
			"      {",
			'        "country_id": 85633159,',
			'        "locality_id": 101750331,',
			'        "region_id": 1360698565',
			"      }",
			"    ],",
			'    "wof:id": 101750331,',
			'    "wof:parent_id": 1360698565',
			"  },",
			'  "geometry": {"coordinates":[0.5,51.4],"type":"Point"}',
			"}",
			"",
		].join("\n")

		const result = repointRecordReferences(before, (id) =>
			id === 1_360_698_565 ? { kind: "replace", id: 1_880_762_057, placetype: "region" } : null
		)

		if (result.kind !== "repointed") throw new Error("expected a repointed record")

		expect(result.text).toBe(before.replaceAll("1360698565", "1880762057"))
	})

	it("leaves a record with no removed reference unchanged", () => {
		expect(repointRecordReferences(purzanMohri(), () => null)).toEqual({ kind: "unchanged" })
	})
})
