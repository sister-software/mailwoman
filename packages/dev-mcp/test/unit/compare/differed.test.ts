/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The coordinate-level `differed` predicate reads a row's own tolerance, and a tier change is its own flag.
 *
 *   The row that set these: `4900 Airport Pkwy, Addison TX 75001` (`us-addison-zip-75001`, tolerance 100 m, tier
 *   `address_point`). A reader change moved its answer from the rooftop to an interpolated point 198 m away; both arms
 *   were hits at 1 km, so the protocol thresholds alone read the pair as identical.
 */

import { armsDiffered, tierDiffered } from "@mailwoman/dev-mcp/compare-helpers"
import type { ExternalAnswer } from "@mailwoman/dev-mcp/external-arm"
import { describe, expect, it } from "vitest"

const ROOFTOP: ExternalAnswer = {
	lat: 32.965477,
	lon: -96.827851,
	label: "4900 Airport Pkwy",
	resultType: "address_point",
	noResultReason: null,
}

const INTERPOLATED: ExternalAnswer = { ...ROOFTOP, lat: 32.966059, lon: -96.829856, resultType: "interpolated" }
const NO_ANSWER: ExternalAnswer = { lat: null, lon: null, label: null, resultType: null, noResultReason: "empty" }

describe("armsDiffered against truth", () => {
	it("reads the pair as identical at the protocol thresholds alone", () => {
		// 0 m and 198 m are both hits at 1, 5 and 25 km.
		expect(armsDiffered(ROOFTOP, INTERPOLATED, 0, 0.198, true)).toBe(false)
	})

	it("counts a change of side at the row's own tolerance", () => {
		expect(armsDiffered(ROOFTOP, INTERPOLATED, 0, 0.198, true, 100)).toBe(true)
	})

	it("does not count two answers that are both inside the row's tolerance", () => {
		expect(armsDiffered(ROOFTOP, INTERPOLATED, 0.05, 0.08, true, 100)).toBe(false)
	})

	it("ignores a tolerance of zero or less rather than grading at an impossible radius", () => {
		expect(armsDiffered(ROOFTOP, INTERPOLATED, 0, 0.198, true, 0)).toBe(false)
	})

	it("still counts a protocol-threshold crossing when the row states a coarse tolerance", () => {
		// 0.9 km vs 1.2 km: opposite sides of 1 km, inside a 25 km tolerance on both arms.
		expect(armsDiffered(ROOFTOP, INTERPOLATED, 0.9, 1.2, true, 25_000)).toBe(true)
	})
})

describe("tierDiffered", () => {
	it("flags a rooftop-to-interpolated change", () => {
		expect(tierDiffered(ROOFTOP, INTERPOLATED)).toBe(true)
	})

	it("reads the same tier as unchanged", () => {
		expect(tierDiffered(ROOFTOP, { ...ROOFTOP, lat: 32.9655 })).toBe(false)
	})

	it("is incomparable, not equal, when an arm did not answer or states no tier", () => {
		expect(tierDiffered(ROOFTOP, NO_ANSWER)).toBeUndefined()
		expect(tierDiffered(ROOFTOP, { ...INTERPOLATED, resultType: null })).toBeUndefined()
	})
})
