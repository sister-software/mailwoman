/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the GB outward district derivation.
 */

import { describe, expect, it } from "vitest"

import { gbOutwardFromKey } from "#tools/pipeline/gb/outward"

describe("gbOutwardFromKey — shape, not space-split (#1509)", () => {
	it("derives the outward from the SPACE-STRIPPED form both databases can produce", () => {
		// Code-Point Open's storage form, with names stored space-stripped.
		expect(gbOutwardFromKey("AB101AB")).toBe("AB10")
		expect(gbOutwardFromKey("SW1A2AA")).toBe("SW1A")
		// The spaced display form, keyed identically.
		expect(gbOutwardFromKey("SW1A 2AA")).toBe("SW1A")
		expect(gbOutwardFromKey("so4 3rx")).toBe("SO4")
	})

	it("rejects anything that is not a GB unit shape", () => {
		expect(gbOutwardFromKey("75008")).toBeNull() // FR five-digit
		expect(gbOutwardFromKey("1012LG")).toBeNull() // NL PC6
		expect(gbOutwardFromKey("SW1A")).toBeNull() // already an outward
		expect(gbOutwardFromKey("")).toBeNull()
	})
})
