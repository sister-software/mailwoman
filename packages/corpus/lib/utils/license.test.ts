/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	compileLicenseExcludes,
	createLicenseVerdictCache,
	licenseExcluded,
	LicensePolicy,
	LicenseRefusalKind,
	licenseVerdict,
} from "#utils/license"

/**
 * A license value measured in `v0.7.0-de-holdout`, where the grant is unresolved
 * and the provenance prose names OpenStreetMap's licence.
 * An anchored prefix match over the raw column admits it.
 */
const SUB_VENUE =
	"Synthetic — OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) placed in " +
	"a Who's On First locality (CC0)"

describe("licenseVerdict under LicensePolicy.All", () => {
	it("admits every value, including one whose expression carries share-alike", () => {
		for (const value of ["ODbL-1.0", "CC0-1.0", SUB_VENUE, "Public Domain", ""]) {
			expect(licenseVerdict(value, LicensePolicy.All).refusal).toBeNull()
		}
	})

	it("still reports whether the value resolved, so an admitted row's unknown obligations are visible", () => {
		expect(licenseVerdict("CC-BY-4.0", LicensePolicy.All).resolved).toBe(true)
		expect(licenseVerdict("Public Domain", LicensePolicy.All).resolved).toBe(true)
		expect(licenseVerdict(SUB_VENUE, LicensePolicy.All).resolved).toBe(false)
	})
})

describe("licenseVerdict under LicensePolicy.ShareAlikeFree", () => {
	it("refuses a stated share-alike grant under the carried class", () => {
		for (const value of ["ODbL-1.0", "CC-BY-SA-4.0", "CC-BY-SA-3.0"]) {
			expect(licenseVerdict(value, LicensePolicy.ShareAlikeFree).refusal).toBe(LicenseRefusalKind.ShareAlikeCarried)
		}
	})

	it("refuses a share-alike licence spelled in prose under the mentioned class", () => {
		// `Open Database License v1.0` is the licence's name rather than its SPDX identifier,
		// so the value states no grant this repository has recorded obligations for.
		// The two classes are separate because one reports what the row's own grant is
		// and the other what its text names.
		expect(licenseVerdict("Open Database License v1.0", LicensePolicy.ShareAlikeFree).refusal).toBe(
			LicenseRefusalKind.ShareAlikeMentioned
		)
	})

	it("admits ODC-By, the attribution-only Open Data Commons license, which is confused with ODbL", () => {
		expect(licenseVerdict("ODC-By-1.0", LicensePolicy.ShareAlikeFree).refusal).toBeNull()
		expect(licenseVerdict("ODC-By-1.0", LicensePolicy.ResolvedOnly).refusal).toBeNull()
	})

	it("refuses prose mentioning a share-alike licence, which /^ODbL/ admitted", () => {
		const verdict = licenseVerdict(SUB_VENUE, LicensePolicy.ShareAlikeFree)

		expect(verdict.refusal).toBe(LicenseRefusalKind.ShareAlikeMentioned)
		expect(verdict.mentionsShareAlike).toBe(true)
		// The defect this replaces: the value starts with neither identifier.
		expect(licenseExcluded(SUB_VENUE, compileLicenseExcludes("ODbL,CC-BY-SA"))).toBe(false)
	})

	it("admits a permissive grant, and BAN's elected Licence Ouverte among them", () => {
		for (const value of ["CC0-1.0", "Public Domain", "CC-BY-4.0", "Licence Ouverte 2.0", "CDLA-Permissive-2.0"]) {
			expect(licenseVerdict(value, LicensePolicy.ShareAlikeFree).refusal).toBeNull()
		}
	})

	it("admits an unresolved value mentioning no share-alike licence, and reports it as unresolved", () => {
		const verdict = licenseVerdict("Totally-Made-Up-1.0", LicensePolicy.ShareAlikeFree)

		expect(verdict.refusal).toBeNull()
		expect(verdict.resolved).toBe(false)
	})
})

describe("licenseVerdict under LicensePolicy.ResolvedOnly", () => {
	it("refuses a value resolving to no expression", () => {
		expect(licenseVerdict("Totally-Made-Up-1.0", LicensePolicy.ResolvedOnly).refusal).toBe(
			LicenseRefusalKind.Unresolved
		)

		expect(licenseVerdict("", LicensePolicy.ResolvedOnly).refusal).toBe(LicenseRefusalKind.Unresolved)
		expect(licenseVerdict(undefined, LicensePolicy.ResolvedOnly).refusal).toBe(LicenseRefusalKind.Unresolved)
	})

	it("reports the share-alike classes ahead of the unresolved one, so a refusal states its evidence", () => {
		expect(licenseVerdict(SUB_VENUE, LicensePolicy.ResolvedOnly).refusal).toBe(LicenseRefusalKind.ShareAlikeMentioned)
	})
})

describe("operator-named prefixes", () => {
	it("compileLicenseExcludes builds anchored, case-insensitive prefix patterns", () => {
		const p = compileLicenseExcludes("ODbL, CC-BY-SA")

		expect(licenseExcluded("ODbL-1.0", p)).toBe(true)
		expect(licenseExcluded("odbl-1.0", p)).toBe(true)
		expect(licenseExcluded("CC-BY-SA-3.0", p)).toBe(true)
		// The prefix is anchored, so a CC-BY-SA exclusion leaves CC-BY unchanged.
		expect(licenseExcluded("CC-BY-4.0", p)).toBe(false)
		expect(licenseExcluded("Licence Ouverte 2.0", p)).toBe(false)
	})

	it("an operator prefix refuses under every policy, and reports its own class", () => {
		const excluded = compileLicenseExcludes("CC-BY")

		expect(licenseVerdict("CC-BY-4.0", LicensePolicy.All, excluded).refusal).toBe(LicenseRefusalKind.OperatorExcluded)
	})

	it("no pattern and LicensePolicy.All refuse every value, which keeps exclusion a deliberate act", () => {
		expect(licenseExcluded("ODbL-1.0", [])).toBe(false)
		expect(licenseVerdict("ODbL-1.0", LicensePolicy.All, []).refusal).toBeNull()
	})
})

describe("createLicenseVerdictCache", () => {
	it("returns the same verdict for a repeated value and records every refused value", () => {
		const cache = createLicenseVerdictCache(LicensePolicy.ShareAlikeFree)

		expect(cache.read("ODbL-1.0")).toBe(cache.read("ODbL-1.0"))
		cache.read(SUB_VENUE)
		cache.read("CC0-1.0")

		expect(cache.refusedValues()).toEqual(
			new Map([
				["ODbL-1.0", LicenseRefusalKind.ShareAlikeCarried],
				[SUB_VENUE, LicenseRefusalKind.ShareAlikeMentioned],
			])
		)
	})

	it("reads an absent value under the same key as the empty string", () => {
		const cache = createLicenseVerdictCache(LicensePolicy.ResolvedOnly)

		expect(cache.read(undefined)).toBe(cache.read(""))
	})
})
