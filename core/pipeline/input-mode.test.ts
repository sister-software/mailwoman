/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decision-A register mapping (Option-A evidence bundle, 2026-07-28): the kind→InputMode derivation
 *   the pipeline applies when a caller doesn't set the mode explicitly. The fence guards the register
 *   split the three-run verdict established — multi-component postal specifications run channels-off;
 *   single-thing lookups run channels-on.
 */

import { describe, expect, it } from "vitest"

import { deriveInputMode } from "./types.ts"

describe("deriveInputMode (Decision A)", () => {
	it("multi-component postal kinds are the formatted register", () => {
		expect(deriveInputMode("structured_address")).toBe("formatted")
		expect(deriveInputMode("po_box")).toBe("formatted")
		expect(deriveInputMode("intersection")).toBe("formatted")
	})

	it("single-thing lookups are the fragmented register", () => {
		expect(deriveInputMode("postcode_only")).toBe("fragmented")
		expect(deriveInputMode("locality_only")).toBe("fragmented")
		expect(deriveInputMode("landmark")).toBe("fragmented")
		expect(deriveInputMode("poi_query")).toBe("fragmented")
		expect(deriveInputMode("vague")).toBe("fragmented")
	})
})
