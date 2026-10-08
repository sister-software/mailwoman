/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decision-A register mapping (Option-A evidence bundle, 2026-07-28): the kind→InputMode derivation
 *   the pipeline applies when a caller doesn't set the mode explicitly. The fence guards the register
 *   split the three-run verdict established — multi-component postal specifications run channels-off.
 *   single-thing lookups run channels-on.
 */

import { describe, expect, it } from "vitest"

import { deriveInputMode } from "#pipeline/types"

describe("deriveInputMode (Decision A)", () => {
	it("multi-component postal kinds are the formatted register", () => {
		expect(deriveInputMode("auto", "structured_address")).toBe("formatted")
		expect(deriveInputMode("auto", "po_box")).toBe("formatted")
		expect(deriveInputMode("auto", "intersection")).toBe("formatted")
	})

	it("single-thing lookups are the fragmented register", () => {
		expect(deriveInputMode("auto", "postcode_only")).toBe("fragmented")
		expect(deriveInputMode("auto", "locality_only")).toBe("fragmented")
		expect(deriveInputMode("auto", "landmark")).toBe("fragmented")
		expect(deriveInputMode("auto", "poi_query")).toBe("fragmented")
		expect(deriveInputMode("auto", "vague")).toBe("fragmented")
	})

	it("an explicit register passes through regardless of kind", () => {
		expect(deriveInputMode("fragmented", "structured_address")).toBe("fragmented")
		expect(deriveInputMode("formatted", "poi_query")).toBe("formatted")
	})
})
