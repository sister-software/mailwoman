/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { isSupersededRecord, roundRecordGeometry, SlimSkip, wofGeometryHash } from "#tools/pipeline/wof/slim"

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
