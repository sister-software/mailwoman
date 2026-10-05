/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { ScenarioInput, ScenarioInputError, validateScenario } from "#scenario"
import { BUILDING_A, BUILDING_B, SHARED_ROUTE, withChange } from "#test/fixtures/shared-route"

/**
 * Runs `validateScenario` and returns the error it throws, or fails the test when it throws none.
 */
function rejection(change: Parameters<typeof withChange>[1]): ScenarioInputError {
	try {
		validateScenario(withChange(SHARED_ROUTE, change))
	} catch (error) {
		if (error instanceof ScenarioInputError) return error

		throw error
	}

	throw new Error("validateScenario accepted the changed scenario")
}

describe("a complete synthetic scenario", () => {
	test("validates", () => {
		expect(() => validateScenario(SHARED_ROUTE)).not.toThrow()
	})

	test("an absent block of assumptions is named, instead of failing on its first property", () => {
		const error = rejection((draft) => {
			Reflect.deleteProperty(draft, "operating")
		})

		expect(error.input).toBe(ScenarioInput.Field)
		expect(error.path).toBe("operating")
	})
})

describe("a missing rate", () => {
	test("a construction line whose rate is absent from the rate card names the line and the rate", () => {
		const error = rejection((draft) => {
			draft.rateCard.rates = draft.rateCard.rates.filter((rate) => rate.id !== "trench-m")
		})

		expect(error.name).toBe("ScenarioInputError")
		expect(error.input).toBe(ScenarioInput.Rate)
		expect(error.path).toBe("segments[shared-route].lines[shared-route-trench].rate")
		expect(error.message).toContain('rate card synthetic-rates version 1 has no rate "trench-m"')
	})

	test("a rate without an amount names the rate", () => {
		const error = rejection((draft) => {
			const rate = draft.rateCard.rates.find((entry) => entry.id === "activation")!

			Reflect.deleteProperty(rate, "amount")
		})

		expect(error.input).toBe(ScenarioInput.Rate)
		expect(error.path).toBe("rateCard.rates[activation].amount")
	})

	test("an operating rate absent from the rate card names the assumption", () => {
		const error = rejection((draft) => {
			draft.operating.serviceRate = "service-premium"
		})

		expect(error.input).toBe(ScenarioInput.Rate)
		expect(error.path).toBe("operating.serviceRate")
	})
})

describe("a missing unit", () => {
	test("a quantity without a unit names the line", () => {
		const error = rejection((draft) => {
			draft.buildings[0]!.works[0]!.quantity.unit = ""
		})

		expect(error.input).toBe(ScenarioInput.Unit)
		expect(error.path).toBe(`buildings[${BUILDING_A}].works[a-branch].quantity.unit`)
	})

	test("a quantity in another unit than its rate names both units", () => {
		const error = rejection((draft) => {
			draft.buildings[1]!.works[0]!.quantity.unit = "ft"
		})

		expect(error.input).toBe(ScenarioInput.Unit)
		expect(error.message).toContain('quantity is in "ft" and rate trench-m is per "m"')
	})

	test("an activation rate charged per meter is refused, because activation is charged per customer", () => {
		const error = rejection((draft) => {
			draft.operating.activationRate = "trench-m"
		})

		expect(error.input).toBe(ScenarioInput.Unit)
		expect(error.path).toBe("operating.activationRate")
	})
})

describe("a missing date", () => {
	test("an absent as-of date", () => {
		const error = rejection((draft) => {
			draft.asOf = ""
		})

		expect(error.input).toBe(ScenarioInput.Date)
		expect(error.path).toBe("asOf")
	})

	test("a malformed month-zero date", () => {
		const error = rejection((draft) => {
			draft.monthZero = "2026-13-01"
		})

		expect(error.input).toBe(ScenarioInput.Date)
		expect(error.path).toBe("monthZero")
	})

	test("a day the month does not have", () => {
		const error = rejection((draft) => {
			draft.monthZero = "2026-02-30"
		})

		expect(error.input).toBe(ScenarioInput.Date)
		expect(error.path).toBe("monthZero")
	})

	test("a rate card stated after the as-of date could not have been known then", () => {
		const error = rejection((draft) => {
			draft.rateCard.statedOn = "2026-10-15"
		})

		expect(error.input).toBe(ScenarioInput.Date)
		expect(error.path).toBe("rateCard.statedOn")
	})
})

describe("a missing selected building identity", () => {
	test("a selected building without a plan", () => {
		const error = rejection((draft) => {
			draft.selected = [BUILDING_A, "building:example-z"]
		})

		expect(error.input).toBe(ScenarioInput.Building)
		expect(error.path).toBe("selected[1]")
		expect(error.message).toContain("building:example-z")
	})

	test("an empty selected building identifier", () => {
		const error = rejection((draft) => {
			draft.selected = [""]
		})

		expect(error.input).toBe(ScenarioInput.Building)
	})

	test("a building selected twice", () => {
		const error = rejection((draft) => {
			draft.selected = [BUILDING_B, BUILDING_B]
		})

		expect(error.input).toBe(ScenarioInput.Building)
		expect(error.message).toContain("selected twice")
	})
})

describe("values outside their range", () => {
	test("a payment month after the horizon would drop the payment from the table", () => {
		const error = rejection((draft) => {
			draft.replacements[0]!.month = 49
		})

		expect(error.input).toBe(ScenarioInput.Month)
		expect(error.path).toBe("replacements[electronics-refresh].month")
	})

	test("a fractional quantity", () => {
		const error = rejection((draft) => {
			draft.segments[0]!.lines[0]!.quantity.value = 400.5
		})

		expect(error.input).toBe(ScenarioInput.Quantity)
	})

	test("a take rate above 100 percent", () => {
		const error = rejection((draft) => {
			draft.operating.uptake.takeRateBasisPoints = 10_001
		})

		expect(error.input).toBe(ScenarioInput.Percentage)
	})

	test("an occupancy schedule that starts after month 0 leaves the earlier months unstated", () => {
		const error = rejection((draft) => {
			draft.buildings[1]!.occupancy = draft.buildings[1]!.occupancy.slice(1)
		})

		expect(error.input).toBe(ScenarioInput.Occupancy)
		expect(error.path).toBe(`buildings[${BUILDING_B}].occupancy[0].fromMonth`)
	})

	test("an occupancy schedule that falls", () => {
		const error = rejection((draft) => {
			draft.buildings[1]!.occupancy = [
				{ fromMonth: 0, units: 16, basis: draft.buildings[1]!.occupancy[0]!.basis },
				{ fromMonth: 6, units: 8, basis: draft.buildings[1]!.occupancy[0]!.basis },
			]
		})

		expect(error.input).toBe(ScenarioInput.Occupancy)
	})

	test("two cost lines with one identifier", () => {
		const error = rejection((draft) => {
			draft.buildings[1]!.works[0]!.id = "a-branch"
		})

		expect(error.input).toBe(ScenarioInput.Identifier)
		expect(error.message).toContain("a-branch")
	})

	test("an unknown currency code", () => {
		const error = rejection((draft) => {
			draft.currency = "ZZZ"
		})

		expect(error.input).toBe(ScenarioInput.Currency)
	})

	test("a route that names an undefined segment", () => {
		const error = rejection((draft) => {
			draft.buildings[0]!.route = ["shared-route", "north-spur"]
		})

		expect(error.input).toBe(ScenarioInput.Segment)
		expect(error.path).toBe(`buildings[${BUILDING_A}].route[1]`)
	})
})
