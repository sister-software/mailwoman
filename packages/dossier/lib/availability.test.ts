/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { availabilityAt, type ProviderAvailability } from "#availability"
import { HOUSE } from "#test/fixtures/example-house"

const RECORDS: ProviderAvailability[] = [
	{
		provider: "Example Fiber",
		subject: HOUSE,
		product: "1 Gbps",
		from: "2022-03-01",
		to: "2022-09-30",
		evidence: { source: "survey-2022" },
	},
]

describe("dated availability", () => {
	test("answers available inside the advertised interval", () => {
		expect(availabilityAt(RECORDS, "Example Fiber", HOUSE, "2022-06-30")).toEqual({
			status: "available",
			records: RECORDS,
		})
	})

	test("answers withdrawn after the product was withdrawn", () => {
		expect(availabilityAt(RECORDS, "Example Fiber", HOUSE, "2022-12-01").status).toBe("withdrawn")
	})

	test("answers unknown before the first record and for a provider with no record", () => {
		expect(availabilityAt(RECORDS, "Example Fiber", HOUSE, "2021-01-01").status).toBe("unknown")
		expect(availabilityAt(RECORDS, "Other Co", HOUSE, "2022-06-30")).toEqual({ status: "unknown", records: [] })
	})
})
