/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { InputBasisKind } from "@mailwoman/route-scenarios"
import { describe, expect, test } from "vitest"

import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	DISTRICT_RECORDS,
	DISTRICT_SCENARIO,
	districtDossier,
	PLANT_RECORD,
	SEGMENT_PATHS,
} from "#example-district"
import { MapInputError } from "#inputs"
import { routeFeatures, type SegmentPath, SegmentStatus } from "#routes"

const dossier = districtDossier()

function segmentsOf(selection: readonly string[]) {
	return routeFeatures(dossier, DISTRICT_SCENARIO, SEGMENT_PATHS, selection).features.map((entry) => [
		entry.properties.segment,
		entry.properties.status,
		entry.properties.shared,
		entry.properties.usedBy,
	])
}

function withPath(change: Partial<SegmentPath>): SegmentPath[] {
	return [{ ...SEGMENT_PATHS[0]!, ...change }, SEGMENT_PATHS[1]!]
}

describe("routeFeatures", () => {
	test("a segment with an admitted source record is verified, and one on an operator assumption is proposed", () => {
		expect(segmentsOf([BUILDING_A, BUILDING_B, BUILDING_C])).toEqual([
			["shared-trench", SegmentStatus.Proposed, true, [BUILDING_A, BUILDING_B]],
			["existing-duct", SegmentStatus.Verified, false, [BUILDING_C]],
		])
	})

	test("a segment is shared only while more than one selected building uses it", () => {
		expect(segmentsOf([BUILDING_A])).toEqual([["shared-trench", SegmentStatus.Proposed, false, [BUILDING_A]]])

		expect(segmentsOf([BUILDING_A, BUILDING_B])).toEqual([
			["shared-trench", SegmentStatus.Proposed, true, [BUILDING_A, BUILDING_B]],
		])
	})

	test("returns each path as a GeoJSON line with its basis, its synthetic label and the selection's cost of the segment", () => {
		const [trench, duct] = routeFeatures(dossier, DISTRICT_SCENARIO, SEGMENT_PATHS).features

		expect(trench!.geometry).toEqual({
			type: "LineString",
			coordinates: [
				[-20.009, -30.0095],
				[-20.01, -30.0099],
				[-20.0103, -30.0101],
			],
		})

		expect(trench!.properties).toMatchObject({
			description: "Proposed trench from the splice point to Example Buildings A and B",
			basis: { kind: InputBasisKind.OperatorAssumption, statedBy: "synthetic example for #2289" },
			synthetic: true,
			economics: { amount: 1_000_000, currency: "USD", synthetic: true },
		})

		expect(duct!.properties.basis).toEqual({ kind: InputBasisKind.SourceRecord, source: PLANT_RECORD })
		expect(duct!.properties.economics.amount).toBe(100_000)
	})

	test("refuses a source-record basis that the dossier has not admitted", () => {
		const later = {
			id: "synthetic-plant-record-2027",
			publisher: "Synthetic example",
			title: "Synthetic plant record published after the as-of date",
			availableAt: "2027-01-05",
		}

		const records = { ...DISTRICT_RECORDS, sources: [...DISTRICT_RECORDS.sources, later] }
		const basis = { kind: InputBasisKind.SourceRecord, source: later.id }

		expect(() => routeFeatures(districtDossier(records), DISTRICT_SCENARIO, withPath({ basis }), [BUILDING_A])).toThrow(
			/became available on 2027-01-05, after the as-of date 2026-09-30/
		)

		expect(() =>
			routeFeatures(dossier, DISTRICT_SCENARIO, withPath({ basis: { ...basis, source: "no-such-record" } }))
		).toThrow(/no-such-record is not a record in the dossier/)
	})

	test("refuses a selection that uses a segment without a path, and a path for an undefined segment", () => {
		expect(() => routeFeatures(dossier, DISTRICT_SCENARIO, [SEGMENT_PATHS[1]!], [BUILDING_A])).toThrow(
			/shared-trench has no path/
		)

		expect(() => routeFeatures(dossier, DISTRICT_SCENARIO, withPath({ segment: "ghost" }))).toThrow(MapInputError)
	})

	test("refuses a path with fewer than two positions or a position outside the range of longitude and latitude", () => {
		expect(() => routeFeatures(dossier, DISTRICT_SCENARIO, withPath({ coordinates: [[-20.009, -30.0095]] }))).toThrow(
			/at least two positions/
		)

		expect(() =>
			routeFeatures(
				dossier,
				DISTRICT_SCENARIO,
				withPath({
					coordinates: [
						[-20.009, -30.0095],
						[-30.0099, -200.01],
					],
				})
			)
		).toThrow(/outside/)
	})
})
