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
