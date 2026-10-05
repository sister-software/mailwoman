/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import { type BuildingPosition, type ExtentMembership, positionOf, readingBuildings } from "#placement"
import { ANNEX, HOUSE } from "#test/fixtures/example-house"

const SURVEY = { source: "survey-2022" }

function membership(subject: string, extent: string): ExtentMembership {
	return { subject, extent, evidence: SURVEY }
}

function position(latitude: number, longitude: number, source = "survey-2022"): BuildingPosition {
	return { subject: HOUSE, latitude, longitude, synthetic: true, evidence: { source } }
}

/**
 * A cable reading over `extent` with no subject.
 */
function reading(extent: string, overrides: Partial<LayerReading> = {}): LayerReading {
	return { layer: "cable", extent, basis: "source_present", records: 2, evidence: SURVEY, ...overrides }
}

describe("readingBuildings", () => {
	const memberships = [membership(HOUSE, "cell-1"), membership(HOUSE, "district-1"), membership(ANNEX, "district-1")]

	test("a reading with a subject attaches to that building alone", () => {
		expect(readingBuildings(reading("district-1", { subject: HOUSE }), memberships)).toEqual([HOUSE])
	})

	test("a reading without a subject attaches to each building that a membership places in its extent", () => {
		expect(readingBuildings(reading("cell-1"), memberships)).toEqual([HOUSE])
		expect(readingBuildings(reading("district-1"), memberships)).toEqual([HOUSE, ANNEX])
	})

	test("a reading that neither rule places attaches to no building", () => {
		expect(readingBuildings(reading("cell-3"), memberships)).toEqual([])
		expect(readingBuildings(reading("cell-1"), [])).toEqual([])
	})

	test("two memberships of one building in one extent attach the reading once", () => {
		expect(
			readingBuildings(reading("cell-1"), [
				membership(HOUSE, "cell-1"),
				{ ...membership(HOUSE, "cell-1"), evidence: { source: "permit-2021" } },
			])
		).toEqual([HOUSE])
	})
})

describe("positionOf", () => {
	const query = { subject: HOUSE, asOf: "2022-06-30" }

	test("one position resolves to its location and keeps its synthetic label", () => {
		expect(positionOf([position(-30.00012, -20.00034)], query)).toEqual({
			status: "resolved",
			latitude: -30.00012,
			longitude: -20.00034,
			synthetic: true,
			positions: [position(-30.00012, -20.00034)],
		})
	})

	test("two positions at the same location resolve, and the location is synthetic only when both are", () => {
		const sourced = { ...position(-30.00012, -20.00034, "permit-2021"), synthetic: false }
		const answer = positionOf([position(-30.00012, -20.00034), sourced], query)

		expect(answer).toMatchObject({ status: "resolved", latitude: -30.00012, longitude: -20.00034, synthetic: false })
	})

	test("two positions that differ stay unresolved, and the answer lists both", () => {
		const first = position(-30.00021, -20.0003, "permit-2021")
		const second = position(-30.00025, -20.00041)

		expect(positionOf([first, second], query)).toEqual({
			status: "unresolved",
			reason: "2 positions state 2 different locations",
			conflicting: [first, second],
		})
	})

	test("a building without a position is unresolved with nothing listed", () => {
		expect(positionOf([{ ...position(1, 1), subject: ANNEX }], query)).toEqual({
			status: "unresolved",
			reason: "no position on 2022-06-30 for building:example-house",
			conflicting: [],
		})
	})
})
