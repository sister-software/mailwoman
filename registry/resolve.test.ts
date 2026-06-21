/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { scorePair, type TermFrequencyTable } from "@mailwoman/match"
import { describe, expect, it } from "vitest"
import { toGeoJSON } from "./geojson.js"
import { addressFrequencyKey, buildDefaultModel, resolveEntities } from "./resolve.js"
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
		// learnedScorer:false — this asserts the FS-baseline merge behaviour. The NPPES-trained GBT (now the
		// default) is validated on real data + the #603 tests below, not on these 3 synthetic records.
		const { entities, candidatePairs } = resolveEntities(records, { learnedScorer: false })

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
		const { entities } = resolveEntities(records, { learnedScorer: false }) // FS-baseline pipeline assertion
		for (const entity of entities) {
			expect(entity.representative).toBeDefined()
			expect(entity.coordinate).toBeDefined()
		}
	})

	it("the scorer hook overrides the FS weight and drives the clustering (#603)", () => {
		// A learned scorer that rejects every pair → no merges, every record is its own entity.
		const none = resolveEntities(records, { scorer: () => Number.NEGATIVE_INFINITY })
		expect(none.entities).toHaveLength(records.length)
		expect(none.entities.every((e) => e.records.length === 1)).toBe(true)

		// A scorer that accepts every blocked pair → the blocked duplicates (1,2) merge on the learned
		// weight, not the FS weight; the far-away record (3) is never blocked with them, so it stays apart.
		const merged = resolveEntities(records, { scorer: () => 100, threshold: 1 })
		const big = merged.entities.find((e) => e.records.length > 1)
		expect(big?.records.map((r) => r.id).sort()).toEqual(["1", "2"])
	})

	it("learnedScorer: true loads the bundled GBT model and resolves end-to-end (#603)", () => {
		// The opt-in bundled model loads + scores every blocked pair without throwing; the result is a
		// sane entity set (between fully-merged and fully-split). Behaviour on these synthetic records is
		// the model's call — this guards the wiring (load → featurize → gbtScore → cluster), not a number.
		const { entities } = resolveEntities(records, { learnedScorer: true })
		expect(entities.length).toBeGreaterThanOrEqual(1)
		expect(entities.length).toBeLessThanOrEqual(records.length)
		for (const e of entities) expect(e.representative).toBeDefined()
	})

	it("an explicit scorer takes precedence over learnedScorer (#603)", () => {
		// Both set → the explicit scorer wins. It rejects every pair, so nothing merges even though the
		// bundled learned model is also requested.
		const { entities } = resolveEntities(records, {
			learnedScorer: true,
			scorer: () => Number.NEGATIVE_INFINITY,
		})
		expect(entities).toHaveLength(records.length)
	})
})

// Two distinct people at the SAME practice address — the co-located-providers over-merge case (#617).
function coLocated(id: string, given: string, family: string): SourceRecord {
	return {
		id,
		name: { given, family },
		address: {
			components: {},
			canonicalKey: "100 plaza dr",
			raw: "100 Plaza Dr, Houston, TX",
			formatted: "100 Plaza Dr, Houston, TX",
			geocode: { coordinate: { latitude: 29.76, longitude: -95.37 }, tier: "address_point", uncertaintyMeters: 1 },
		},
	}
}

describe("address-frequency down-weighting (#617)", () => {
	it("normalizes the frequency key parse-free (uppercase, punctuation → single spaces)", () => {
		expect(addressFrequencyKey("100 Plaza Dr, Houston, TX")).toBe("100 PLAZA DR HOUSTON TX")
	})

	it("lowers a shared-address link weight when the address is corpus-common", () => {
		const a = coLocated("1", "Robert", "Smith")
		const b = coLocated("2", "Maria", "Garcia") // same address, different people

		const plain = scorePair(buildDefaultModel(), a, b).weight

		// A table marking this exact address as shared by half the corpus — agreement on it is near-worthless.
		const crowded: TermFrequencyTable = {
			total: 1000,
			distinct: 1,
			frequency: (v) => (addressFrequencyKey(v) === "100 PLAZA DR HOUSTON TX" ? 0.5 : 0),
		}
		const downWeighted = scorePair(buildDefaultModel({ addressFrequency: crowded }), a, b).weight

		expect(downWeighted).toBeLessThan(plain)
	})
})

describe("name-or-org corroboration gate (A2, #625)", () => {
	it("suppresses a spatial-only link — a shared address with disagreeing names does not merge", () => {
		const a = coLocated("1", "Robert", "Smith") // same address...
		const b = coLocated("2", "Maria", "Garcia") // ...different people
		// A permissive threshold so the shared address alone WOULD merge them without the gate.
		const without = resolveEntities([a, b], { threshold: -100 })
		expect(without.entities).toHaveLength(1) // over-merge: an address-only link

		const gated = resolveEntities([a, b], { threshold: -100, requireCorroboration: true })
		expect(gated.entities).toHaveLength(2) // the gate holds the distinct providers apart
	})

	it("still merges when names DO corroborate at a shared address", () => {
		const a = coLocated("1", "Robert", "Smith")
		const b = coLocated("2", "Robert", "Smith") // same person, same place — name agreement corroborates
		const res = resolveEntities([a, b], { threshold: -100, requireCorroboration: true })
		expect(res.entities).toHaveLength(1)
	})
})

describe("phone corroboration rescues name drift (A3, #625)", () => {
	it("merges a shared-address, name-drifted pair when they share a phone line", () => {
		const a: SourceRecord = { ...coLocated("1", "Acme", "Health"), phone: "512-555-0100" }
		const b: SourceRecord = { ...coLocated("2", "Saint", "Marys"), phone: "(512) 555-0100" } // same line, drifted name
		// The name/org-only gate (A2) would block this; phone (A3) is the secondary identifier that rescues it.
		const res = resolveEntities([a, b], { threshold: -100, requireCorroboration: true, usePhone: true })
		expect(res.entities).toHaveLength(1)
	})

	it("keeps distinct providers apart when they share an address but NOT a phone", () => {
		const a: SourceRecord = { ...coLocated("1", "Acme", "Health"), phone: "512-555-0100" }
		const b: SourceRecord = { ...coLocated("2", "Saint", "Marys"), phone: "512-555-0200" } // different line
		const res = resolveEntities([a, b], { threshold: -100, requireCorroboration: true, usePhone: true })
		expect(res.entities).toHaveLength(2)
	})
})

describe("secondary-identifier discriminators (#625)", () => {
	it("an agreeing discriminator corroborates a name-drifted shared-address link", () => {
		const a: SourceRecord = { ...coLocated("1", "Acme", "Health"), attributes: { authorizedOfficial: "jane smith" } }
		const b: SourceRecord = { ...coLocated("2", "Saint", "Marys"), attributes: { authorizedOfficial: "jane smith" } } // same registrant
		const res = resolveEntities([a, b], {
			threshold: -100,
			requireCorroboration: true,
			discriminators: ["authorizedOfficial"],
		})
		expect(res.entities).toHaveLength(1)
	})

	it("a disagreeing discriminator keeps distinct providers apart", () => {
		const a: SourceRecord = { ...coLocated("1", "Acme", "Health"), attributes: { authorizedOfficial: "jane smith" } }
		const b: SourceRecord = { ...coLocated("2", "Saint", "Marys"), attributes: { authorizedOfficial: "bob jones" } }
		const res = resolveEntities([a, b], {
			threshold: -100,
			requireCorroboration: true,
			discriminators: ["authorizedOfficial"],
		})
		expect(res.entities).toHaveLength(2)
	})
})

describe("toGeoJSON", () => {
	it("emits a Point feature per geocoded entity with analyst-facing properties", () => {
		const { entities } = resolveEntities(records, { learnedScorer: false }) // FS-baseline pipeline assertion
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
