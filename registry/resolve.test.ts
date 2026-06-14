/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { toGeoJSON } from "./geojson.js"
import { resolveEntities } from "./resolve.js"
import type { SourceRecord } from "./types.js"

function clinic(
	id: string,
	given: string,
	family: string,
	canonicalKey: string,
	latitude: number,
	longitude: number,
	formatted?: string
): SourceRecord {
	return {
		id,
		name: { given, family },
		address: {
			components: {},
			canonicalKey,
			formatted,
			geocode: { coordinate: { latitude, longitude }, tier: "address_point", uncertaintyMeters: 1 },
		},
	}
}

// Two records for the same clinic — different address STRINGS, same place + name — and a distinct one far away.
const records: SourceRecord[] = [
	clinic("1", "Robert", "Smith", "123 main st", 45.5152, -122.6784, "123 Main St, Portland, OR"),
	clinic("2", "Robert", "Smith", "123 main street apt 2", 45.5153, -122.6785, "123 Main Street Apt 2, Portland, OR"),
	clinic("3", "Maria", "Garcia", "50 elm ave", 47.6062, -122.3321, "50 Elm Ave, Seattle, WA"),
]

describe("resolveEntities", () => {
	it("merges the same-place duplicates and keeps the distinct record separate", () => {
		const { entities, candidatePairs } = resolveEntities(records)

		expect(candidatePairs).toBeGreaterThanOrEqual(1)
		expect(entities).toHaveLength(2)

		const merged = entities.find((e) => e.records.length > 1)!
		expect(merged.records.map((r) => r.id).sort()).toEqual(["1", "2"])
		expect(merged.cohesion).not.toBeNull()
		expect(merged.cohesion!).toBeGreaterThan(0)

		const singleton = entities.find((e) => e.records.length === 1)!
		expect(singleton.records[0]!.id).toBe("3")
		expect(singleton.cohesion).toBeNull()
	})

	it("runs label-free with EM training without error", () => {
		const { entities } = resolveEntities(records, { trainEM: true })
		expect(entities.length).toBeGreaterThanOrEqual(1)
	})

	it("picks a representative and a coordinate per entity", () => {
		const { entities } = resolveEntities(records)
		for (const entity of entities) {
			expect(entity.representative).toBeDefined()
			expect(entity.coordinate).toBeDefined()
		}
	})
})

describe("toGeoJSON", () => {
	it("emits a Point feature per geocoded entity with analyst-facing properties", () => {
		const { entities } = resolveEntities(records)
		const fc = toGeoJSON(entities)

		expect(fc.type).toBe("FeatureCollection")
		expect(fc.features).toHaveLength(2)

		const feature = fc.features[0]!
		expect(feature.geometry.type).toBe("Point")
		expect(feature.geometry.coordinates).toHaveLength(2)
		// [longitude, latitude] order per the GeoJSON spec.
		expect(feature.geometry.coordinates[0]).toBeLessThan(0)
		expect(feature.properties).toMatchObject({ entityId: expect.any(String), recordCount: expect.any(Number) })

		const merged = fc.features.find((f) => f.properties.recordCount === 2)!
		expect(merged.properties.name).toBe("Robert Smith")
		expect(merged.properties.geocodeTier).toBe("address_point")
	})
})
