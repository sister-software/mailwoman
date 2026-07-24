/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure-codex guard for the FR conventions row (#719). The shipped neural model emits the FR LEADING
 *   `street_prefix` (Rue/Avenue/Cours/…) correctly, but the #511 forbid masked it to −1e9 before
 *   Viterbi and destroyed it on real French addresses (F1 0.0 vs 80.0 mask-off; the larger real-FR
 *   eval saw ~96 → ~0.6). These assertions fail in CI — no model, no weights — if a future change
 *   re-forbids `street_prefix`, so the live bug cannot silently reappear. The model-level
 *   regression check is a separate, later build step.
 */

import { describe, expect, it } from "vitest"

import { ADDRESS_SYSTEM_CONVENTIONS, conventionsForSystem } from "./address-system-conventions.ts"
import { UK_POSTCODE_PATTERN } from "./gb/postcode.ts"

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
		// Same object as gb/postcode.ts's UK_POSTCODE_PATTERN — the shape family is declared once in the codex.
		expect(gb!.postcodePattern).toBe(UK_POSTCODE_PATTERN)
	})

	it("the declared shape accepts canonical GB postcodes and rejects the #1275 clip fragments", () => {
		const pattern = conventionsForSystem("gb")!.postcodePattern!

		for (const valid of ["SK11 9PD", "SW1A 1AA", "M1 1AE", "B33 8TH", "CR2 6XH", "DN55 1PT"]) {
			expect(valid).toMatch(pattern)
		}

		// Clip fragments from the #1275 board ("1 9PD" for SK11 9PD, "2LH" for CV31 2LH, "3 2GL" for
		// WF3 2GL) are shape-invalid. (A letter-led fragment like "K11 9PD" can still be shape-valid in
		// isolation — the repair pass operates on raw-text sub-match, not fragment shape, so the pattern
		// only needs to describe the canonical form.)
		for (const clipped of ["1 9PD", "2LH", "3 2GL"]) {
			expect(clipped).not.toMatch(pattern)
		}
	})

	it("forbids NO tags — the row exists for the postcode snap-repair gate only", () => {
		// A forbid needs measured zero-cost receipts (the FR street_prefix lesson, #719). GB has none.
		expect(conventionsForSystem("gb")!.forbiddenTags).toBeUndefined()
	})
})
