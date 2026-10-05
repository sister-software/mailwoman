/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitStage } from "@mailwoman/dossier"
import { sum } from "@mailwoman/route-scenarios"
import { describe, expect, test } from "vitest"

import { BuildingState, buildingFeatures } from "#buildings"
import { districtFeatures } from "#districts"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	BUILDING_E,
	BUILDING_F,
	BUILDING_G,
	districtDossier,
	GARAGE,
} from "#example-district"
import { MapInputError } from "#inputs"
import {
	ADDISCOMBE_GROVE,
	CRICKLEWOOD_LANE,
	LONDON_SITES,
	londonDossier,
	PENTONVILLE_ROAD,
	sitePosition,
} from "#london-three-buildings"

const dossier = districtDossier()
const options = { unitStage: UnitStage.Completed, extentKind: "example-district" }
const districts = districtFeatures(dossier, options)

describe("districtFeatures", () => {
	test("returns one feature per district, then the buildings that one membership of the kind does not place", () => {
		expect(
			districts.features.map((entry) => [
				entry.properties.placement,
				entry.properties.extent,
				entry.properties.buildings,
			])
		).toEqual([
			["clustered", "example-district:north", [BUILDING_A, BUILDING_B, BUILDING_E]],
			["clustered", "example-district:south", [BUILDING_C, GARAGE]],
			["unplaced", null, [BUILDING_F]],
			["ambiguous", null, [BUILDING_G]],
		])
	})

	test("a cluster sums resolved unit totals and counts the buildings with an unresolved total apart", () => {
		const [north, south] = districts.features

		expect(north!.properties.units).toEqual({ stage: "completed", resolved: 40, unresolvedBuildings: 1 })

		expect(north!.properties.states).toEqual({
			[BuildingState.UnknownUnitCount]: 1,
			[BuildingState.ZeroPremises]: 0,
			[BuildingState.PartialAvailability]: 1,
			[BuildingState.KnownUnserved]: 1,
			[BuildingState.UnknownCoverage]: 0,
		})

		expect(south!.properties.units).toEqual({ stage: "completed", resolved: 30, unresolvedBuildings: 0 })
		expect(south!.properties.states[BuildingState.ZeroPremises]).toBe(1)
	})

	test("the district features preserve the building-scale denominators", () => {
		const buildings = buildingFeatures(dossier, { unitStage: UnitStage.Completed }).features

		const resolved = buildings.flatMap((entry) =>
			entry.properties.units.total === "unresolved" ? [] : [entry.properties.units.total]
		)

		expect(sum(districts.features.map((entry) => entry.properties.units.resolved))).toBe(sum(resolved))
		expect(sum(resolved)).toBe(90)

		expect(sum(districts.features.map((entry) => entry.properties.units.unresolvedBuildings))).toBe(
			buildings.filter((entry) => entry.properties.units.total === "unresolved").length
		)

		expect(sum(districts.features.map((entry) => entry.properties.buildings.length))).toBe(buildings.length)

		for (const state of Object.values(BuildingState)) {
			expect(sum(districts.features.map((entry) => entry.properties.states[state]))).toBe(
				buildings.filter((entry) => entry.properties.state === state).length
			)
		}
	})

	test("a cluster's geometry holds the resolved positions of its buildings", () => {
		const [north, south] = districts.features

		expect(north!.geometry).toEqual({
			type: "MultiPoint",
			coordinates: [
				[-20.01, -30.01],
				[-20.0104, -30.0102],
				[-20.0107, -30.0098],
			],
		})

		// Example Building C's two positions differ, so only the garage has a point.
		expect(south!.geometry).toEqual({ type: "MultiPoint", coordinates: [[-20.0101, -30.0123]] })
		expect(south!.properties.buildings).toContain(BUILDING_C)
	})

	test("clusters by the kind the caller chooses", () => {
		const cells = districtFeatures(dossier, { ...options, extentKind: "example-cell" })

		expect(cells.features.map((entry) => [entry.properties.extent, entry.properties.buildings.length])).toEqual([
			["example-cell:b", 1],
			["example-cell:c", 1],
			[null, 5],
		])
	})

	test("refuses an extent kind that is empty or holds a colon", () => {
		expect(() => districtFeatures(dossier, { ...options, extentKind: " " })).toThrow(MapInputError)
		expect(() => districtFeatures(dossier, { ...options, extentKind: "example-district:north" })).toThrow(/extentKind/)
	})
})

describe("districtFeatures: the three London buildings by planning authority", () => {
	const london = londonDossier()
	const authorities = districtFeatures(london, { unitStage: UnitStage.Planned, extentKind: "planning-authority" })

	function states(counts: Partial<Record<BuildingState, number>>): Record<BuildingState, number> {
		return { ...Object.fromEntries(Object.values(BuildingState).map((state) => [state, 0])), ...counts } as Record<
			BuildingState,
			number
		>
	}

	test("clusters each building under the planning authority its planning row states", () => {
		expect(
			authorities.features.map((entry) => [
				entry.properties.placement,
				entry.properties.extent,
				entry.properties.buildings,
			])
		).toEqual([
			["clustered", "planning-authority:Croydon", [ADDISCOMBE_GROVE]],
			["clustered", "planning-authority:Barnet", [CRICKLEWOOD_LANE]],
			["clustered", "planning-authority:Islington", [PENTONVILLE_ROAD]],
		])
	})

	test("sums only resolved planned totals and counts the unresolved one apart", () => {
		expect(authorities.features.map((entry) => [entry.properties.units, entry.properties.states])).toEqual([
			[{ stage: "planned", resolved: 153, unresolvedBuildings: 0 }, states({ [BuildingState.UnknownCoverage]: 1 })],
			[{ stage: "planned", resolved: 122, unresolvedBuildings: 0 }, states({ [BuildingState.UnknownCoverage]: 1 })],
			[{ stage: "planned", resolved: 0, unresolvedBuildings: 1 }, states({ [BuildingState.UnknownUnitCount]: 1 })],
		])

		const buildings = buildingFeatures(london, { unitStage: UnitStage.Planned }).features

		expect(sum(authorities.features.map((entry) => entry.properties.units.resolved))).toBe(275)
		expect(sum(authorities.features.map((entry) => entry.properties.buildings.length))).toBe(buildings.length)
	})

	test("a cluster's geometry is its building's converted planning grid reference", () => {
		expect(authorities.features.map((entry) => entry.geometry)).toEqual(
			LONDON_SITES.map((site) => {
				const { latitude, longitude } = sitePosition(site)

				return { type: "MultiPoint", coordinates: [[longitude, latitude]] }
			})
		)
	})
})
