/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { RESOLVE_SWITCH_DEFAULTS, resolveSwitches } from "#resolver/types"

describe("resolveSwitches", () => {
	test("an empty option bag yields the defaults table", () => {
		expect(resolveSwitches({})).toEqual(RESOLVE_SWITCH_DEFAULTS)
	})

	// The resolver used to read these inline: `!== false` for the default-on passes
	// and `=== true` (or `?? false`) for the default-off ones.
	// The table keeps both meanings.
	test("default-on switches match the former `!== false` reads", () => {
		for (const key of [
			"parentFallback",
			"spanRescore",
			"postalCompoundRecovery",
			"postcodeConsistency",
			"postcodeCountryCoherence",
			"adminCoherence",
			"hierarchyCompletion",
		] as const) {
			expect(resolveSwitches({})[key]).toBe(true)
			expect(resolveSwitches({ [key]: false })[key]).toBe(false)
		}
	})

	test("default-off switches match the former `=== true` reads", () => {
		for (const key of [
			"addressPointBboxFallback",
			"spanRescoreRequireContextRemainder",
			"postcodeShapeCoherence",
			"postcodeContainmentCoherence",
			"postcodePrefixPrior",
			"includeAncestors",
			"adminContainmentRerank",
			"diagnoseUnreachable",
		] as const) {
			expect(resolveSwitches({})[key]).toBe(false)
			expect(resolveSwitches({ [key]: true })[key]).toBe(true)
		}
	})

	test("an explicit undefined falls back to the default", () => {
		expect(resolveSwitches({ adminCoherence: undefined }).adminCoherence).toBe(true)
	})
})
