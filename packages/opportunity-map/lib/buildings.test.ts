/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type EntityID, UnitStage } from "@mailwoman/dossier"
import { describe, expect, test } from "vitest"

import { BuildingState, buildingFeatures } from "#buildings"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	BUILDING_E,
	BUILDING_F,
	BUILDING_G,
	DISTRICT_RECORDS,
	districtDossier,
	GARAGE,
	INSPECTION,
	LISTING,
	PERMIT,
	SURVEY,
} from "#example-district"
import {
	ADDISCOMBE_GROVE,
	CRICKLEWOOD_LANE,
	LONDON_SITES,
	londonDossier,
	PENTONVILLE_ROAD,
	sitePosition,
} from "#london-three-buildings"

const collection = buildingFeatures(districtDossier(), { unitStage: UnitStage.Completed })

function feature(building: EntityID) {
	return collection.features.find((entry) => entry.properties.building === building)!
}

describe("buildingFeatures: the five states", () => {
	test("returns a GeoJSON feature collection with one feature per building", () => {
		expect(collection.type).toBe("FeatureCollection")

		expect(collection.features.map((entry) => entry.properties.building)).toEqual([
			BUILDING_A,
			BUILDING_B,
			BUILDING_C,
			GARAGE,
			BUILDING_E,
			BUILDING_F,
			BUILDING_G,
		])
	})

	test("partial availability: a provider is recorded as available, and no record covers every unit", () => {
		expect(feature(BUILDING_A).properties).toMatchObject({
			state: BuildingState.PartialAvailability,
			reason:
				"On 2026-09-30, Example Fiber Co fiber 1 Gbps is recorded as available. No admitted record establishes service to all 24 completed units.",
			units: { stage: "completed", at: "2026-08-01", total: 24, sources: [INSPECTION] },
			service: {
				available: [{ provider: "Example Fiber Co", product: "fiber 1 Gbps", sources: [LISTING] }],
				checks: [],
			},
			sources: [INSPECTION, LISTING],
		})

		expect(feature(BUILDING_A).properties.service.available[0]).toHaveProperty("extent", null)
	})

	test("partial availability over an extent: the reason and the service evidence keep the record's extent", () => {
		const records = {
			...DISTRICT_RECORDS,
			availability: DISTRICT_RECORDS.availability.map((record) => ({ ...record, extent: "example-cell:a" })),
		}

		const properties = buildingFeatures(districtDossier(records), { unitStage: UnitStage.Completed }).features.find(
			(entry) => entry.properties.building === BUILDING_A
		)!.properties

		expect(properties).toMatchObject({
			state: BuildingState.PartialAvailability,
			reason:
				"On 2026-09-30, Example Fiber Co fiber 1 Gbps is recorded as available over example-cell:a. No admitted record establishes service to all 24 completed units.",
			service: {
				available: [
					{ provider: "Example Fiber Co", product: "fiber 1 Gbps", extent: "example-cell:a", sources: [LISTING] },
				],
			},
			sources: [INSPECTION, LISTING],
		})
	})

	test("a record for the building and a record over an extent are stated apart, and an ended record states no availability", () => {
		const [listing] = DISTRICT_RECORDS.availability

		const records = {
			...DISTRICT_RECORDS,
			availability: [
				listing!,
				{ ...listing!, extent: "example-cell:a", evidence: { source: SURVEY } },
				{
					...listing!,
					from: "2026-01-01",
					to: "2026-05-31",
					extent: "example-district:north",
					evidence: { source: PERMIT },
				},
			],
		}

		const properties = buildingFeatures(districtDossier(records), { unitStage: UnitStage.Completed }).features.find(
			(entry) => entry.properties.building === BUILDING_A
		)!.properties

		expect(properties.reason).toBe(
			"On 2026-09-30, Example Fiber Co fiber 1 Gbps is recorded as available and Example Fiber Co fiber 1 Gbps is recorded as available over example-cell:a. No admitted record establishes service to all 24 completed units."
		)

		expect(properties.service.available).toEqual([
			{ provider: "Example Fiber Co", product: "fiber 1 Gbps", extent: null, sources: [LISTING] },
			{ provider: "Example Fiber Co", product: "fiber 1 Gbps", extent: "example-cell:a", sources: [SURVEY] },
		])

		expect(properties.sources).toEqual([INSPECTION, LISTING, SURVEY])
	})

	test("known unserved: the latest readings of every check establish absence", () => {
		expect(feature(BUILDING_B).properties).toMatchObject({
			state: BuildingState.KnownUnserved,
			reason:
				"On 2026-09-30, the latest readings of check b-fiber establish absence, and no provider is recorded as available.",
			units: { total: 16 },
			service: {
				available: [],
				checks: [
					{
						check: "b-fiber",
						layer: "example-fiber",
						extent: "example-cell:b",
						status: "surveyed_empty",
						vintage: "2026-07-15",
						sources: [SURVEY],
					},
				],
			},
			sources: [INSPECTION, SURVEY],
		})
	})

	test("unknown coverage: a source-present zero establishes no absence", () => {
		expect(feature(BUILDING_C).properties).toMatchObject({
			state: BuildingState.UnknownCoverage,
			reason:
				"On 2026-09-30, no provider is recorded as available. The latest readings are source_present_empty for check c-fiber, so service at the building is unknown.",
			units: { total: 30 },
			sources: [INSPECTION, SURVEY],
		})
	})

	test("unknown coverage: a building with no check and no provider record", () => {
		expect(feature(BUILDING_F).properties).toMatchObject({
			state: BuildingState.UnknownCoverage,
			reason: "On 2026-09-30, no provider is recorded as available, and the building has no check.",
			service: { available: [], checks: [] },
			sources: [INSPECTION],
		})
	})

	test("zero premises: the unit total resolves to 0", () => {
		expect(feature(GARAGE).properties).toMatchObject({
			state: BuildingState.ZeroPremises,
			reason: "The completed unit total is 0 on 2026-08-01.",
			units: { stage: "completed", total: 0, sources: [INSPECTION] },
		})
	})

	test("unknown unit count: the denominator is the word unresolved, never a zero", () => {
		expect(feature(BUILDING_E).properties).toMatchObject({
			state: BuildingState.UnknownUnitCount,
			reason: "The completed unit total is unresolved: no completed count on 2026-09-30 for building:example-e.",
			units: {
				stage: "completed",
				total: "unresolved",
				reason: "no completed count on 2026-09-30 for building:example-e",
				sources: [],
			},
			sources: [],
		})
	})

	test("conflicting counts leave the total unresolved and cite both counts", () => {
		const records = {
			...DISTRICT_RECORDS,
			counts: [
				...DISTRICT_RECORDS.counts,
				{ ...DISTRICT_RECORDS.counts[0]!, id: "a-completed-survey", count: 26, evidence: { source: SURVEY } },
			],
		}

		const a = buildingFeatures(districtDossier(records), { unitStage: UnitStage.Completed }).features[0]!

		expect(a.properties).toMatchObject({
			state: BuildingState.UnknownUnitCount,
			units: { total: "unresolved", sources: [INSPECTION, SURVEY] },
		})
	})

	test("the denominator follows the unit stage the caller chooses", () => {
		const planned = buildingFeatures(districtDossier(), { unitStage: UnitStage.Planned })
		const states = new Map(planned.features.map((entry) => [entry.properties.building, entry.properties.state]))

		expect(states.get(BUILDING_E)).toBe(BuildingState.UnknownCoverage)

		expect(planned.features.find((entry) => entry.properties.building === BUILDING_E)!.properties.units).toEqual({
			stage: "planned",
			at: "2026-03-01",
			total: 40,
			sources: [PERMIT],
		})

		expect(states.get(BUILDING_A)).toBe(BuildingState.UnknownUnitCount)
	})

	test("every state appears in the fixture, and each building holds exactly one", () => {
		expect(new Set(collection.features.map((entry) => entry.properties.state))).toEqual(
			new Set(Object.values(BuildingState))
		)
	})
})

describe("buildingFeatures: geometry, access and economics", () => {
	test("a resolved position is a point at [longitude, latitude], labeled synthetic with its source", () => {
		expect(feature(BUILDING_A).geometry).toEqual({ type: "Point", coordinates: [-20.01, -30.01] })
		expect(feature(BUILDING_A).properties.position).toEqual({ status: "resolved", synthetic: true, sources: [SURVEY] })
	})

	test("two positions that differ leave the geometry null and list both", () => {
		expect(feature(BUILDING_C).geometry).toBeNull()

		expect(feature(BUILDING_C).properties.position).toEqual({
			status: "unresolved",
			reason: "2 positions state 2 different locations",
			candidates: [
				{ latitude: -30.012, longitude: -20.011, synthetic: true, source: SURVEY },
				{ latitude: -30.0121, longitude: -20.0113, synthetic: true, source: INSPECTION },
			],
		})
	})

	test("units, service and access are separate groups, and a building carries no economic figure", () => {
		expect(Object.keys(feature(BUILDING_A).properties).toSorted()).toEqual([
			"access",
			"building",
			"label",
			"position",
			"reason",
			"service",
			"sources",
			"state",
			"units",
		])

		expect(feature(BUILDING_A).properties.access).toEqual({ permissions: [], roles: [] })
	})
})

describe("buildingFeatures: the three London buildings at the planned stage", () => {
	const london = buildingFeatures(londonDossier(), { unitStage: UnitStage.Planned })

	// The fixture's identifiers keep each planning reference, so the tests name them through the fixture.
	const [addiscombe, cricklewood, pentonville] = LONDON_SITES

	function londonFeature(building: EntityID) {
		return london.features.find((entry) => entry.properties.building === building)!
	}

	test("28-30 Addiscombe Grove: two sources agree on 153 planned units, and no record bears on service", () => {
		const sources = [addiscombe!.ldd, "gla-referral-3831a"]

		expect(addiscombe!.referral?.source).toBe("gla-referral-3831a")

		expect(londonFeature(ADDISCOMBE_GROVE).properties).toMatchObject({
			label: "28-30 Addiscombe Grove",
			state: BuildingState.UnknownCoverage,
			reason: "On 2026-10-05, no provider is recorded as available, and the building has no check.",
			units: { stage: "planned", at: "2018-02-20", total: 153, sources },
			service: { available: [], checks: [] },
			sources,
		})
	})

	test("112-132 Cricklewood Lane: the planning row's 122 planned units, and no record bears on service", () => {
		expect(londonFeature(CRICKLEWOOD_LANE).properties).toMatchObject({
			label: "112-132 Cricklewood Lane",
			state: BuildingState.UnknownCoverage,
			reason: "On 2026-10-05, no provider is recorded as available, and the building has no check.",
			units: { stage: "planned", at: "2016-08-30", total: 122, sources: [cricklewood!.ldd] },
			sources: [cricklewood!.ldd],
		})
	})

	test("130-154, 154a Pentonville Road: 119 and 118 planned units leave the denominator unresolved", () => {
		const reason = `2 counts share the same subject, stage, date and membership (${pentonville!.key}:residential-units) and disagree: 119 versus 118`
		const sources = [pentonville!.ldd, "gla-referral-2924b"]

		expect(pentonville!.referral?.source).toBe("gla-referral-2924b")

		expect(londonFeature(PENTONVILLE_ROAD).properties).toMatchObject({
			label: "130-154, 154a Pentonville Road",
			state: BuildingState.UnknownUnitCount,
			reason: `The planned unit total is unresolved: ${reason}.`,
			units: { stage: "planned", at: "2014-12-12", total: "unresolved", reason, sources },
			sources,
		})
	})

	test("each feature is a point at the converted planning grid reference, sourced to the planning row and not synthetic", () => {
		expect(london.features.map((entry) => [entry.geometry, entry.properties.position])).toEqual(
			LONDON_SITES.map((site) => {
				const { latitude, longitude } = sitePosition(site)

				return [
					{ type: "Point", coordinates: [longitude, latitude] },
					{ status: "resolved", synthetic: false, sources: [site.ldd] },
				]
			})
		)
	})

	test("at the completed stage every building has an unknown unit count, because no source states a completed count", () => {
		const completed = buildingFeatures(londonDossier(), { unitStage: UnitStage.Completed })

		expect(completed.features.map((entry) => entry.properties.state)).toEqual([
			BuildingState.UnknownUnitCount,
			BuildingState.UnknownUnitCount,
			BuildingState.UnknownUnitCount,
		])
	})
})
