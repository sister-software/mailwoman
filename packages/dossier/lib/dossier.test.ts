/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import { buildDossier, type Dossier } from "#dossier"
import type { EntityID } from "#identifiers"
import { ANNEX, EXAMPLE_RECORDS, HOUSE, NORTH } from "#test/fixtures/example-house"
import { OPP_BUILDING, OPP_RECORDS } from "#test/fixtures/one-park-point"

function sectionOf(dossier: Dossier, building: EntityID) {
	return dossier.buildings.find((section) => section.building.id === building)!
}

/**
 * A surveyed-empty reading over `cell-2`, an extent the Example House fixture never reads.
 */
function cell2Reading(overrides: Partial<LayerReading>): LayerReading {
	return {
		layer: "ducts",
		extent: "cell-2",
		basis: "surveyed",
		surveyedAt: "2022-03-15",
		records: 0,
		evidence: { source: "survey-2022" },
		...overrides,
	}
}

describe("buildDossier as of 2022-06-30", () => {
	const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })
	const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

	test("admits the permit, inspection and survey. Excludes the 2023 statement. Lists the undated listing", () => {
		expect(dossier.admitted).toEqual(["permit-2021", "inspection-2022", "survey-2022"])
		expect(dossier.excluded).toEqual([{ id: "manager-2023", availableAt: "2023-02-01", observedAt: "2023-02-01" }])
		expect(dossier.undated).toEqual(["undated-listing"])
	})

	test("the 2023 occupied count and the undated 22 do not reach the sections", () => {
		expect(house.counts.occupied).toMatchObject({
			status: "unresolved",
			reason: expect.stringMatching(/no occupied count/),
		})

		expect(house.counts.completed).toMatchObject({ status: "resolved", total: 20 })
	})

	test("the north entrance permission is scoped to the entrance", () => {
		expect(house.permissions.map((event) => event.scope)).toEqual([[NORTH]])
	})

	test("signing authority and the open construction window are unresolved with the record that would resolve them", () => {
		const questions = house.unresolved.map((item) => item.question)

		expect(questions).toContainEqual(expect.stringMatching(/Example Holdings LLC.*signing authority/))
		expect(questions).toContainEqual(expect.stringMatching(/construction window.*no end/))
		expect(house.unresolved.every((item) => item.missingRecord.length > 0)).toBe(true)
	})

	test("a record observed before the cutoff but available after it is excluded", () => {
		const late = buildDossier(
			{
				...EXAMPLE_RECORDS,
				sources: [
					...EXAMPLE_RECORDS.sources,
					{ id: "late", publisher: "p", title: "t", observedAt: "2022-01-01", availableAt: "2022-12-01" },
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(late.excluded).toContainEqual({ id: "late", availableAt: "2022-12-01", observedAt: "2022-01-01" })
	})

	test("refuses records with a validation error", () => {
		expect(() =>
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					containment: [
						{ child: "entrance:ghost", parent: HOUSE, relation: "entrance_of", evidence: { source: "survey-2022" } },
					],
				},
				{ asOf: "2022-06-30" }
			)
		).toThrow(/unknown_entity/)
	})
})

describe("buildDossier: the building a layer reading attaches to", () => {
	test("a reading with a subject attaches to that building and to no other", () => {
		const dossier = buildDossier(
			{ ...EXAMPLE_RECORDS, readings: [...EXAMPLE_RECORDS.readings, cell2Reading({ subject: ANNEX })] },
			{ asOf: "2022-06-30" }
		)

		expect(sectionOf(dossier, ANNEX).readings).toContainEqual({
			layer: "ducts",
			extent: "cell-2",
			surveyedAt: "2022-03-15",
			class: "surveyed_empty",
		})

		expect(sectionOf(dossier, HOUSE).readings.map((reading) => reading.extent)).not.toContain("cell-2")
	})

	test("a reading without a subject attaches to every building", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		expect(EXAMPLE_RECORDS.readings.every((reading) => reading.subject === undefined)).toBe(true)

		for (const building of [HOUSE, ANNEX]) {
			expect(sectionOf(dossier, building).readings.map((reading) => reading.layer)).toEqual([
				"ducts",
				"cabinets",
				"poles",
			])
		}
	})

	test("two vintages of one layer and extent for one subject stay two readings", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [
					cell2Reading({ subject: HOUSE, basis: "source_present", surveyedAt: "2021-03-15", records: 0 }),
					cell2Reading({ subject: HOUSE, basis: "source_present", surveyedAt: "2022-03-15", records: 3 }),
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(sectionOf(dossier, HOUSE).readings).toEqual([
			{ layer: "ducts", extent: "cell-2", surveyedAt: "2021-03-15", class: "source_present_empty" },
			{ layer: "ducts", extent: "cell-2", surveyedAt: "2022-03-15", class: "records" },
		])

		expect(sectionOf(dossier, ANNEX).readings).toEqual([])
	})

	test("a layer and extent whose texts concatenate alike stay two readings", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [
					cell2Reading({ layer: "duct", extent: "s-cell" }),
					cell2Reading({ layer: "ducts", extent: "-cell" }),
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(sectionOf(dossier, HOUSE).readings.map((reading) => [reading.layer, reading.extent])).toEqual([
			["duct", "s-cell"],
			["ducts", "-cell"],
		])
	})

	test("refuses a reading whose subject is not a building", () => {
		expect(() =>
			buildDossier({ ...EXAMPLE_RECORDS, readings: [cell2Reading({ subject: NORTH })] }, { asOf: "2022-06-30" })
		).toThrow(/subject_not_building/)
	})
})

describe("buildDossier as of 2023-06-30", () => {
	test("admits the manager statement and resolves the occupied count", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2023-06-30" })
		const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

		expect(house.counts.occupied).toMatchObject({ status: "resolved", total: 18 })
	})
})

describe("one park point, real records", () => {
	const building = OPP_BUILDING

	describe("as of 2022-06-30, the pre-permit decision date", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2022-06-30" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("admits only the filing and the pavement plan. Excludes everything published later", () => {
			expect(dossier.admitted).toEqual(["dobnow-filing-b00520132-i1", "dob-bpp-3314476"])

			expect(dossier.excluded.map((record) => record.id)).toEqual([
				"dobnow-approval-b00520132-i1",
				"dobnow-first-permit-b00520132-i1",
				"pluto-26v2",
				"pad-geosearch-26c",
				"fcc-bdc-cable-j22",
				"fcc-bdc-fttp-j22",
				"fcc-bdc-fttp-d25",
			])
		})

		test("shows 375 planned units from the filing, with completed and occupied unresolved", () => {
			expect(section.counts.planned).toMatchObject({ status: "resolved", total: 375 })

			expect(section.counts.completed).toMatchObject({
				status: "unresolved",
				reason: expect.stringMatching(/no completed count/),
			})
		})

		test("names the developer and architect with signing authority unknown, and no provider or reading", () => {
			expect(section.authority.unknown.map((relation) => relation.organization)).toEqual([
				"JEMB Realty",
				"FXCollaborative Architects LLP",
			])

			expect(section.availability).toEqual([])
			expect(section.readings).toEqual([])

			expect(section.unresolved.map((item) => item.question)).toContainEqual(
				expect.stringMatching(/construction window.*no end/)
			)
		})
	})

	describe("as of 2023-06-30, with the first BDC vintage public", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2023-06-30" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("shows Charter cable at the block and Verizon not yet filed there", () => {
			expect(section.availability.map((entry) => [entry.provider, entry.answer.status])).toEqual([
				["Charter Communications (Spectrum)", "available"],
			])

			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-block:360470504012000",
				surveyedAt: "2022-06-30",
				class: "source_present_empty",
			})

			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-tract:36047050401",
				surveyedAt: "2022-06-30",
				class: "records",
			})
		})

		test("the completed count stays unresolved until PLUTO", () => {
			expect(section.counts.completed).toMatchObject({ status: "unresolved" })
		})
	})

	describe("as of 2026-10-05, retrieval day", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2026-10-05" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("resolves the alias, the completed count and Verizon FTTP at the block", () => {
			expect(section.aliases).toEqual([
				{
					text: "11 Ocean Parkway, Brooklyn, NY 11218",
					resolution: { kind: "resolved", entity: building, evidence: { source: "pad-geosearch-26c" } },
				},
			])

			expect(section.counts.completed).toMatchObject({ status: "resolved", total: 375 })

			expect(section.availability.map((entry) => [entry.provider, entry.answer.status])).toEqual([
				["Charter Communications (Spectrum)", "available"],
				["Verizon", "available"],
			])
		})

		test("the two FTTP vintages are separate surveys, never a conflict", () => {
			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-block:360470504012000",
				surveyedAt: "2025-12-31",
				class: "records",
			})

			expect(section.readings.every((reading) => reading.class !== "conflicting")).toBe(true)
		})
	})
})
