/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { mapUnitJurisdiction } from "#tools/coverage/natural-earth"

const unit = (ISO_A2: string, ISO_A2_EH: string, ADM0_A3: string, NAME = "unit") => ({
	ISO_A2,
	ISO_A2_EH,
	ADM0_A3,
	NAME,
})

describe("mapUnitJurisdiction", () => {
	it("reads the code from ISO_A2_EH, where ISO_A2 holds -99 or a subdivision code", () => {
		expect(mapUnitJurisdiction(unit("-99", "FR", "FRA", "France"))).toBe("FR")
		expect(mapUnitJurisdiction(unit("FR-973", "GF", "FRA", "French Guiana"))).toBe("GF")
		expect(mapUnitJurisdiction(unit("CN-TW", "TW", "TWN", "Taiwan"))).toBe("TW")
	})

	it("gives the US Minor Outlying Islands their own code", () => {
		expect(mapUnitJurisdiction(unit("-99", "US", "UMI", "Wake Atoll"))).toBe("UM")
	})

	it("gives no jurisdiction to a disputed area that carries -99 in both fields", () => {
		expect(mapUnitJurisdiction(unit("-99", "-99", "BRT", "Bir Tawil"))).toBeNull()
	})
})
