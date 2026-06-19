/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { compileLicenseExcludes, licenseExcluded, SHARE_ALIKE_PATTERN } from "./license.js"

describe("license exclusion (#26)", () => {
	it("SHARE_ALIKE_PATTERN matches Tier-C share-alike, not Tier-A/B", () => {
		for (const l of ["ODbL-1.0", "Open Database License v1.0", "CC-BY-SA-4.0", "CC-SA-1.0"]) {
			expect(SHARE_ALIKE_PATTERN.test(l)).toBe(true)
		}
		// Tier A (PD/CC0) + Tier B (CC-BY / Licence Ouverte) must NOT match — they're allowed.
		for (const l of ["CC0-1.0", "Public Domain", "CC-BY-4.0", "Licence Ouverte 2.0"]) {
			expect(SHARE_ALIKE_PATTERN.test(l)).toBe(false)
		}
	})

	it("compileLicenseExcludes builds anchored, case-insensitive prefix patterns", () => {
		const p = compileLicenseExcludes("ODbL, CC-BY-SA")
		expect(licenseExcluded("ODbL-1.0", p)).toBe(true)
		expect(licenseExcluded("odbl-1.0", p)).toBe(true) // case-insensitive
		expect(licenseExcluded("CC-BY-SA-3.0", p)).toBe(true)
		// CC-BY (Tier B) must NOT be caught by a CC-BY-SA exclusion — the prefix is anchored.
		expect(licenseExcluded("CC-BY-4.0", p)).toBe(false)
		expect(licenseExcluded("Licence Ouverte 2.0", p)).toBe(false)
	})

	it("default (no patterns) excludes NOTHING — exclusion is a deliberate act, not a default", () => {
		expect(licenseExcluded("ODbL-1.0", [])).toBe(false)
		expect(licenseExcluded(undefined, [SHARE_ALIKE_PATTERN])).toBe(false)
	})

	it("--exclude-share-alike (SHARE_ALIKE_PATTERN) leaves elected-Licence-Ouverte BAN untouched", () => {
		// The BAN election: stamped `Licence Ouverte 2.0`, so a proprietary-weights build's
		// share-alike exclusion does NOT drop it (the whole point of correcting the conservative stamp).
		expect(licenseExcluded("Licence Ouverte 2.0", [SHARE_ALIKE_PATTERN])).toBe(false)
	})
})
