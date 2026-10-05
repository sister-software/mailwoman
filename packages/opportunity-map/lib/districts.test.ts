/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitStage } from "@mailwoman/dossier"
import { describe, expect, test } from "vitest"

import { BuildingState, buildingFeatures } from "#buildings"
import { districtFeatures } from "#districts"
import { MapInputError } from "#inputs"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	BUILDING_E,
	BUILDING_F,
	BUILDING_G,
	districtDossier,
	GARAGE,
} from "#test/fixtures/example-district"

const dossier = districtDossier()
const options = { unitStage: UnitStage.Completed, extentKind: "example-district" }
const districts = districtFeatures(dossier, options)

function total(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0)
}

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

		expect(total(districts.features.map((entry) => entry.properties.units.resolved))).toBe(total(resolved))
		expect(total(resolved)).toBe(90)

		expect(total(districts.features.map((entry) => entry.properties.units.unresolvedBuildings))).toBe(
			buildings.filter((entry) => entry.properties.units.total === "unresolved").length
		)

		expect(total(districts.features.map((entry) => entry.properties.buildings.length))).toBe(buildings.length)

		for (const state of Object.values(BuildingState)) {
			expect(total(districts.features.map((entry) => entry.properties.states[state]))).toBe(
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
