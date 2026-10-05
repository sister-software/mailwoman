/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { projectCashFlow } from "#cash-flow"
import { prepareScenario } from "#eligibility"
import { ScenarioInput } from "#scenario"
import {
	ACQUISITION as acquisition,
	BUILDING_B,
	LEASE as lease,
	SALVAGE as salvage,
	scheduled,
	SHARED_ROUTE,
	syntheticDossier,
	transaction,
	WHOLESALE,
} from "#test/fixtures/shared-route"
import { TransactionKind, transactionView } from "#transactions"

const prepared = prepareScenario(syntheticDossier(), SHARED_ROUTE)
const base = projectCashFlow(prepared)

describe("salvage", () => {
	test("adds stated proceeds in the last month only, which the zero-terminal-value base case leaves out", () => {
		const view = transactionView(prepared, salvage)

		// Month 48: 86,000 + 400,000 = 486,000, and 486,000 / 1.4641 = 331,944.54, so 331,945 against the base's 58,739.
		expect(view.rows[48]).toMatchObject({
			baseCashFlow: 86_000,
			proceeds: 400_000,
			caseCashFlow: 486_000,
			presentValue: 331_945,
		})

		expect(view.npv).toBe(267_608 - 58_739 + 331_945)
		expect(view.baseNPV).toBe(base.npv)
		expect(view.reconciles).toBe(true)
		expect(base.rows[48]!.cashFlow).toBe(86_000)
	})

	test("a sale before the horizon is refused, because the table would keep the sold plant's later flows", () => {
		expect(() =>
			transactionView(prepared, {
				...salvage,
				integrationMonth: 30,
				proceeds: [scheduled("early-resale", 30, 30, 400_000)],
			})
		).toThrow(expect.objectContaining({ input: ScenarioInput.Month }))
	})
})

describe("lease", () => {
	test("a leased segment is paid by lease instead of construction, never both", () => {
		const view = transactionView(prepared, lease)

		// Month 1: −1,100,000 + 1,000,000 avoided − 15,000 of lease = −115,000.
		expect(view.rows[1]).toMatchObject({
			baseCashFlow: -1_100_000,
			avoidedConstruction: 1_000_000,
			subscriberChange: 0,
			obligations: 15_000,
			caseCashFlow: -115_000,
		})

		expect(view.adjusted.construction.total).toBe(600_000)
		expect(view.adjusted.construction.segments).toEqual([])
		// 795,500 + 1,000,000 − 48 × 15,000 = 1,075,500.
		expect(view.totals.caseCashFlow).toBe(1_075_500)
		expect(view.reconciles).toBe(true)
	})

	test("leasing a segment the selection does not use is refused", () => {
		expect(() => transactionView(prepared, { ...lease, leasedSegments: ["north-spur"] })).toThrow(
			expect.objectContaining({ input: ScenarioInput.Segment })
		)
	})

	test("leasing one segment twice is refused", () => {
		expect(() => transactionView(prepared, { ...lease, leasedSegments: ["shared-route", "shared-route"] })).toThrow(
			expect.objectContaining({ input: ScenarioInput.Segment })
		)
	})
})

describe("acquisition", () => {
	test("acquired subscribers join in month 6 without activation cost and are never counted as new activations", () => {
		const view = transactionView(prepared, acquisition)

		// A holds 9 after month 5.
		// Four join, so 13 exceed the target of 12 and A's new activations are 0.
		// B activates 1.
		expect(view.adjusted.rows[6]!.buildings[0]).toMatchObject({ active: 13, joined: 4, newActivations: 0 })
		expect(view.adjusted.rows[6]!.acquisitionAndActivation).toBe(30_000)

		// Receipts +5,500, credits −16,500, service +1,000, activations −90,000: +111,000.
		// Less the 160,000 price.
		expect(view.rows[6]).toMatchObject({
			baseCashFlow: -74_000,
			subscriberChange: 111_000,
			obligations: 160_000,
			caseCashFlow: -123_000,
		})

		expect(view.reconciles).toBe(true)
	})

	test("acquired subscribers in a building the scenario does not select are refused", () => {
		expect(() =>
			transactionView(prepared, { ...acquisition, acquiredSubscribers: [{ building: "building:example-z", count: 4 }] })
		).toThrow(expect.objectContaining({ input: ScenarioInput.Building }))
	})

	test("acquired subscribers above the occupied units are refused", () => {
		expect(() =>
			transactionView(prepared, {
				...acquisition,
				integrationMonth: 3,
				acquiredSubscribers: [{ building: BUILDING_B, count: 1 }],
			})
		).toThrow(expect.objectContaining({ input: ScenarioInput.Subscribers }))
	})
})

describe("wholesale", () => {
	test("wholesale fees and the port cost they need enter as proceeds and obligations from month 12", () => {
		const view = transactionView(prepared, WHOLESALE)

		// Month 12: 86,000 + 20,000 − 2,000 = 104,000.
		// Over months 12 to 48: 37 × 18,000 = 666,000.
		expect(view.rows[12]!.caseCashFlow).toBe(104_000)
		expect(view.totals.caseCashFlow - base.totals.cashFlow).toBe(666_000)
	})

	test("a wholesale case without proceeds is refused", () => {
		expect(() =>
			transactionView(prepared, transaction({ id: "wholesale", kind: TransactionKind.Wholesale, integrationMonth: 12 }))
		).toThrow(expect.objectContaining({ input: ScenarioInput.Amount }))
	})
})
