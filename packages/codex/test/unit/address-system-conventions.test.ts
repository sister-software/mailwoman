/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Guards the French street-prefix convention and the GB postcode pattern without loading model
 *   weights. The FR assertion prevents `street_prefix` from being forbidden again.
 */

import { ADDRESS_SYSTEM_CONVENTIONS, conventionsForSystem } from "@mailwoman/codex/address-system-conventions"
import { UK_POSTCODE_PATTERN } from "@mailwoman/codex/gb"
import { describe, expect, it } from "vitest"

describe("FR address-system conventions (#719)", () => {
	it("does NOT forbid street_prefix — FR uses a LEADING street type the current model emits correctly", () => {
		const fr = conventionsForSystem("fr")
		expect(fr).not.toBeNull()
		expect(fr!.forbiddenTags ?? []).not.toContain("street_prefix")
	})

	it("KEEPS street_suffix forbidden — FR has no trailing street suffix (measured: zero leakage, free constraint)", () => {
		const fr = conventionsForSystem("fr")
		expect(fr!.forbiddenTags ?? []).toContain("street_suffix")
	})

	it("the literal table row agrees with the lookup (no aliasing surprise)", () => {
		expect(ADDRESS_SYSTEM_CONVENTIONS.fr?.forbiddenTags ?? []).not.toContain("street_prefix")
		expect(ADDRESS_SYSTEM_CONVENTIONS.fr?.forbiddenTags ?? []).toContain("street_suffix")
	})
})

describe("GB address-system conventions (#1275)", () => {
	it("declares the codex UK postcode shape — the reference, not a re-declared regex", () => {
		const gb = conventionsForSystem("gb")
		expect(gb).not.toBeNull()
		// The codex and GB postcode parser share one pattern.
		expect(gb!.postcodePattern).toBe(UK_POSTCODE_PATTERN)
	})

	it("the declared shape accepts canonical GB postcodes and rejects the #1275 clip fragments", () => {
		const pattern = conventionsForSystem("gb")!.postcodePattern!

		for (const valid of ["SK11 9PD", "SW1A 1AA", "M1 1AE", "B33 8TH", "CR2 6XH", "DN55 1PT"]) {
			expect(valid).toMatch(pattern)
		}

		// These truncated postcode fragments do not match the canonical pattern.
		for (const clipped of ["1 9PD", "2LH", "3 2GL"]) {
			expect(clipped).not.toMatch(pattern)
		}
	})

	it("forbids NO tags — the row exists for the postcode snap-repair check only", () => {
		// No GB tag forbids have been measured.
		expect(conventionsForSystem("gb")!.forbiddenTags).toBeUndefined()
	})
})
