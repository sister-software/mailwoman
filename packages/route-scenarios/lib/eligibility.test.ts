/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type DossierRecords, UnitStage } from "@mailwoman/dossier"
import { describe, expect, test } from "vitest"

import { prepareScenario, SharedUnitMembershipError, UnresolvedUnitTotalError } from "#eligibility"
import { InputBasisKind, ScenarioInput, ScenarioInputError } from "#scenario"
import {
	BUILDING_A,
	BUILDING_B,
	DOSSIER_RECORDS,
	INSPECTION_SOURCE,
	PARCEL,
	SHARED_ROUTE,
	syntheticDossier,
	UNIT_COUNTS,
	withChange,
} from "#test/fixtures/shared-route"

function withCounts(counts: DossierRecords["counts"]): DossierRecords {
	return { ...DOSSIER_RECORDS, counts }
}

describe("two buildings on one parcel", () => {
	test("each building's units enter once, 24 + 16 = 40, and the parcel adds no units of its own", () => {
		const prepared = prepareScenario(syntheticDossier(), SHARED_ROUTE)

		expect(prepared.eligible).toEqual([
			{
				building: BUILDING_A,
				label: "Example Building A",
				stage: UnitStage.Completed,
				at: "2026-08-01",
				units: 24,
				sources: [INSPECTION_SOURCE],
				memberships: ["example-a:all"],
			},
			{
				building: BUILDING_B,
				label: "Example Building B",
				stage: UnitStage.Completed,
				at: "2026-08-01",
				units: 16,
				sources: [INSPECTION_SOURCE],
				memberships: ["example-b:all"],
			},
		])

		expect(prepared.eligible.reduce((sum, entry) => sum + entry.units, 0)).toBe(40)
	})

	test("a unit membership claimed by both selected buildings is refused instead of counted twice", () => {
		const counts = UNIT_COUNTS.map((count) => ({ ...count, membership: "example-route-parcel:all" }))

		const error = (() => {
			try {
				prepareScenario(syntheticDossier(withCounts(counts)), SHARED_ROUTE)
			} catch (caught) {
				return caught
			}
		})()

		expect(error).toBeInstanceOf(SharedUnitMembershipError)
		expect((error as SharedUnitMembershipError).membership).toBe("example-route-parcel:all")
		expect((error as SharedUnitMembershipError).buildings).toEqual([BUILDING_A, BUILDING_B])
	})

	test("the parcel itself cannot be selected as a building", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.buildings = [...draft.buildings, { ...draft.buildings[0]!, building: PARCEL, works: [] }]
			draft.selected = [BUILDING_A, PARCEL]
		})

		expect(() => prepareScenario(syntheticDossier(), scenario)).toThrow(
			expect.objectContaining({ name: "ScenarioInputError", input: ScenarioInput.Building })
		)
	})
})

describe("an unresolved unit total", () => {
	test("two disagreeing counts stay unresolved: the error carries both values and no unit or subscriber count", () => {
		const counts = [...UNIT_COUNTS, { ...UNIT_COUNTS[0]!, id: "a-completed-26", count: 26 }]

		const error = (() => {
			try {
				prepareScenario(syntheticDossier(withCounts(counts)), SHARED_ROUTE)
			} catch (caught) {
				return caught
			}
		})() as UnresolvedUnitTotalError

		expect(error).toBeInstanceOf(UnresolvedUnitTotalError)
		expect(error.building).toBe(BUILDING_A)
		expect(error.total.status).toBe("unresolved")
		expect(error.total).not.toHaveProperty("total")
		expect(error.total.conflicting.map((count) => count.count)).toEqual([24, 26])
		expect(error.message).toContain("disagree: 24 versus 26")
		expect(error.message).toContain("24 per synthetic-inspection-2026. 26 per synthetic-inspection-2026")
	})

	test("a building with no count at the stage stays unresolved", () => {
		const counts = UNIT_COUNTS.filter((count) => count.subject !== BUILDING_B)

		expect(() => prepareScenario(syntheticDossier(withCounts(counts)), SHARED_ROUTE)).toThrow(
			expect.objectContaining({
				name: "UnresolvedUnitTotalError",
				building: BUILDING_B,
				message: expect.stringContaining("no completed count on 2026-09-30 for building:example-b"),
			})
		)
	})
})

describe("checks against the dossier", () => {
	test("a scenario dated differently from its dossier is refused", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.asOf = "2026-10-31"
			draft.rateCard.statedOn = "2026-09-01"
		})

		expect(() => prepareScenario(syntheticDossier(), scenario)).toThrow(
			expect.objectContaining({ input: ScenarioInput.Date, path: "asOf" })
		)
	})

	test("a quantity whose basis cites a record the dossier did not admit is refused", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.segments[0]!.lines[0]!.quantity.basis = { kind: InputBasisKind.SourceRecord, source: "route-survey-2027" }
		})

		const error = (() => {
			try {
				prepareScenario(syntheticDossier(), scenario)
			} catch (caught) {
				return caught
			}
		})()

		expect(error).toBeInstanceOf(ScenarioInputError)
		expect((error as ScenarioInputError).input).toBe(ScenarioInput.Basis)
		expect((error as ScenarioInputError).path).toBe("segments[shared-route].lines[shared-route-trench].quantity.basis")
	})

	test("a quantity whose basis cites an admitted record is accepted", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.buildings[0]!.works[0]!.quantity.basis = { kind: InputBasisKind.SourceRecord, source: INSPECTION_SOURCE }
		})

		expect(prepareScenario(syntheticDossier(), scenario).eligible).toHaveLength(2)
	})

	test("an occupancy above the building's eligible units is refused", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.buildings[1]!.occupancy = [{ ...draft.buildings[1]!.occupancy[0]!, units: 20 }]
		})

		expect(() => prepareScenario(syntheticDossier(), scenario)).toThrow(
			expect.objectContaining({ input: ScenarioInput.Occupancy, path: `buildings[${BUILDING_B}].occupancy[0].units` })
		)
	})

	test("a plan for a building the dossier lacks is refused even when it is unselected", () => {
		const scenario = withChange(SHARED_ROUTE, (draft) => {
			draft.buildings = [...draft.buildings, { ...draft.buildings[0]!, building: "building:example-c", works: [] }]
		})

		expect(() => prepareScenario(syntheticDossier(), scenario)).toThrow(
			expect.objectContaining({ input: ScenarioInput.Building, path: "buildings[building:example-c]" })
		)
	})
})
