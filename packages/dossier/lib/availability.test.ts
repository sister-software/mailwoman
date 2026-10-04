/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { availabilityAt } from "#availability"
import { AVAILABILITY, HOUSE } from "#test/fixtures/example-house"

describe("dated availability", () => {
	test("answers available inside the advertised interval", () => {
		expect(availabilityAt(AVAILABILITY, "Example Fiber", HOUSE, "2022-06-30")).toEqual({
			status: "available",
			records: AVAILABILITY,
		})
	})

	test("answers withdrawn after the product was withdrawn", () => {
		expect(availabilityAt(AVAILABILITY, "Example Fiber", HOUSE, "2022-12-01").status).toBe("withdrawn")
	})

	test("answers unknown before the first record and for a provider with no record", () => {
		expect(availabilityAt(AVAILABILITY, "Example Fiber", HOUSE, "2021-01-01").status).toBe("unknown")
		expect(availabilityAt(AVAILABILITY, "Other Co", HOUSE, "2022-06-30")).toEqual({ status: "unknown", records: [] })
	})
})
