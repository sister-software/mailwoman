/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { toGeoJSON } from "./geojson.ts"
import type { ResolvedEntity, SourceRecord } from "./types.ts"

const record = (id: string, o: Partial<SourceRecord> = {}): SourceRecord => ({ id, ...o }) as SourceRecord
const entity = (o: Partial<ResolvedEntity>): ResolvedEntity =>
	({ id: "e1", records: [record("r1")], representative: record("r1"), cohesion: null, ...o }) as ResolvedEntity

test("toGeoJSON: empty input → an empty FeatureCollection", () => {
	expect(toGeoJSON([])).toEqual({ type: "FeatureCollection", features: [] })
})

test("toGeoJSON: a coordinate becomes a Point with GeoJSON [longitude, latitude] order", () => {
	const fc = toGeoJSON([entity({ coordinate: { latitude: 40.7484, longitude: -73.9857 } })])
	expect(fc.type).toBe("FeatureCollection")
	expect(fc.features).toHaveLength(1)
	const f = fc.features[0]!
	expect(f.type).toBe("Feature")
	expect(f.geometry.type).toBe("Point")
	// GeoJSON is [lon, lat] — NOT [lat, lon]. This ordering is a classic foot-gun.
	expect(f.geometry.coordinates).toEqual([-73.9857, 40.7484])
})

test("toGeoJSON: entities with no resolved coordinate are omitted", () => {
	const fc = toGeoJSON([
		entity({ id: "has-coord", coordinate: { latitude: 1, longitude: 2 } }),
		entity({ id: "no-coord" }), // coordinate undefined
	])
	expect(fc.features).toHaveLength(1)
	expect(fc.features[0]!.properties.entityID).toBe("has-coord")
})

test("toGeoJSON: properties carry record count, cohesion, and DISTINCT, SORTED sources", () => {
	const fc = toGeoJSON([
		entity({
			id: "x",
			cohesion: 3.5,
			coordinate: { latitude: 1, longitude: 2 },
			records: [
				record("r1", { source: "nppes" }),
				record("r2", { source: "ca-state" }),
				record("r3", { source: "nppes" }), // duplicate source
				record("r4", { source: null }), // null source dropped
			],
		}),
	])
	const p = fc.features[0]!.properties
	expect(p.recordCount).toBe(4)
	expect(p.cohesion).toBe(3.5)
	expect(p.sourceIds).toEqual(["r1", "r2", "r3", "r4"])
	expect(p.sources).toEqual(["ca-state", "nppes"]) // de-duped + sorted; null omitted
})

test("toGeoJSON: displayName joins the representative's name parts; null when absent", () => {
	const named = toGeoJSON([
		entity({
			coordinate: { latitude: 1, longitude: 2 },
			representative: record("rep", { name: { given: "Jane", family: "Doe" } as SourceRecord["name"] }),
		}),
	])
	expect(named.features[0]!.properties.name).toBe("Jane Doe")

	const unnamed = toGeoJSON([entity({ coordinate: { latitude: 1, longitude: 2 } })])
	expect(unnamed.features[0]!.properties.name).toBeNull()
})
