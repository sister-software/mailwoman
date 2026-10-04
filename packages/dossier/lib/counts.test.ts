/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { countsByStage, totalUnits, type UnitCount, UnitStage } from "#counts"
import { ANNEX, HOUSE } from "#test/fixtures/example-house"

const inspection = { source: "inspection-2022", observedAt: "2022-04-01" }

const SHARED: UnitCount[] = [
	{
		id: "u1",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 12,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: inspection,
	},
	{
		id: "u2",
		subject: ANNEX,
		stage: UnitStage.Completed,
		count: 8,
		at: "2022-04-01",
		membership: "example-annex:all",
		evidence: inspection,
	},
]

describe("shared parcel", () => {
	test("sums two buildings' completed units when memberships are distinct", () => {
		const total = totalUnits(SHARED, { subjects: [HOUSE, ANNEX], stage: UnitStage.Completed, at: "2022-04-01" })

		expect(total).toEqual({ status: "resolved", stage: "completed", at: "2022-04-01", total: 20, parts: SHARED })
	})
})

describe("conflicting counts", () => {
	const planned: UnitCount = {
		id: "p",
		subject: HOUSE,
		stage: UnitStage.Planned,
		count: 24,
		at: "2021-05-10",
		membership: "example-house:all",
		evidence: { source: "permit-2021" },
	}

	const completed20: UnitCount = {
		id: "c20",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 20,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: inspection,
	}

	const completed22: UnitCount = {
		id: "c22",
		subject: HOUSE,
		stage: UnitStage.Completed,
		count: 22,
		at: "2022-04-01",
		membership: "example-house:all",
		evidence: { source: "undated-listing" },
	}

	const occupied: UnitCount = {
		id: "o",
		subject: HOUSE,
		stage: UnitStage.Occupied,
		count: 18,
		at: "2023-02-01",
		membership: "example-house:all",
		evidence: { source: "manager-2023" },
	}

	test("keeps planned, completed and occupied apart", () => {
		const byStage = countsByStage([planned, completed20, occupied], HOUSE)

		expect(byStage.planned.map((count) => count.count)).toEqual([24])
		expect(byStage.completed.map((count) => count.count)).toEqual([20])
		expect(byStage.occupied.map((count) => count.count)).toEqual([18])
	})

	test("two completed counts at the same date and scope stay unresolved, never zero and never a sum", () => {
		const total = totalUnits([completed20, completed22], {
			subjects: [HOUSE],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total.status).toBe("unresolved")

		if (total.status === "unresolved") {
			expect(total.conflicting.map((count) => count.count)).toEqual([20, 22])
			expect(total.reason).toMatch(/same subject, stage, date and membership/)
		}
	})

	test("a planned count and a completed count with the same membership never combine", () => {
		const total = totalUnits([planned, completed20], {
			subjects: [HOUSE],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total).toMatchObject({ status: "resolved", total: 20 })
	})

	test("a query with no matching count is unresolved for want of a record", () => {
		const total = totalUnits([planned], { subjects: [HOUSE], stage: UnitStage.Occupied, at: "2022-04-01" })

		expect(total).toMatchObject({ status: "unresolved", reason: expect.stringMatching(/no occupied count/) })
	})

	test("two counts with the same membership key on different subjects are refused as overlapping", () => {
		const overlapping = { ...SHARED[1]!, membership: "example-house:all" }

		const total = totalUnits([SHARED[0]!, overlapping], {
			subjects: [HOUSE, ANNEX],
			stage: UnitStage.Completed,
			at: "2022-04-01",
		})

		expect(total).toMatchObject({
			status: "unresolved",
			reason: expect.stringMatching(/membership example-house:all is claimed by two subjects/),
		})
	})
})
