/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier } from "#dossier"
import { EXAMPLE_RECORDS, HOUSE, NORTH } from "#test/fixtures/example-house"

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

describe("buildDossier as of 2023-06-30", () => {
	test("admits the manager statement and resolves the occupied count", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2023-06-30" })
		const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

		expect(house.counts.occupied).toMatchObject({ status: "resolved", total: 18 })
	})
})
