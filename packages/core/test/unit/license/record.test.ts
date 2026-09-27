/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	carriesShareAlike,
	LicenseObligation,
	LicenseResolution,
	mentionsShareAlike,
	readLicenseRecord,
} from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

/**
 * The `spliced-sub-venue` value, verbatim from 120,000 rows of `v0.7.0-de-holdout`.
 *
 * This is the case a `/^ODbL/` filter over the column could never match,
 * because the string begins "Synthetic".
 */
const SUB_VENUE =
	"Synthetic — OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) and " +
	"Overture Places names (CDLA-Permissive-2.0) over OpenAddresses / HM Land Registry Price Paid Data " +
	"address skeletons"

describe("readLicenseRecord", () => {
	it("resolves an SPDX identifier and reports its recorded obligations", () => {
		const record = readLicenseRecord("ODbL-1.0")

		expect(record.resolution).toBe(LicenseResolution.Resolved)
		expect(record.expression).toBe("ODbL-1.0")
		expect(record.obligations).toContain(LicenseObligation.ShareAlike)
		expect(carriesShareAlike(record)).toBe(true)
	})

	it("resolves the two prose spellings this repository writes for 623.8M rows", () => {
		// `Public Domain` labels 478,632,849 corpus rows and `Licence Ouverte 2.0` labels 145,193,536.
		// Neither is an SPDX identifier, and a lookup keyed on the identifier finds no entry for either.
		const publicDomain = readLicenseRecord("Public Domain")
		const ouverte = readLicenseRecord("Licence Ouverte 2.0")

		expect(publicDomain.expression).toBe("LicenseRef-USGov-Public-Domain")
		expect(publicDomain.obligations).toEqual([])
		expect(ouverte.expression).toBe("etalab-2.0")
		expect(ouverte.obligations).toEqual([LicenseObligation.Attribution])
	})

	it("resolves a stated CC-BY-SA grant, so its share-alike term is carried rather than unrecognized", () => {
		for (const identifier of ["CC-BY-SA-4.0", "CC-BY-SA-3.0", "CC-BY-SA-2.0"]) {
			const record = readLicenseRecord(identifier)

			expect(record.resolution, identifier).toBe(LicenseResolution.Resolved)
			expect(carriesShareAlike(record), identifier).toBe(true)
		}
	})

	it("reads provenance prose as unresolved while recording what it mentions", () => {
		const record = readLicenseRecord(SUB_VENUE)

		expect(record.resolution).toBe(LicenseResolution.Unresolved)
		expect(record.expression).toBeNull()
		expect(record.obligations).toEqual([])
		expect(record.mentions).toContain("ODbL-1.0")
		expect(record.mentions).toContain("CDLA-Permissive-2.0")
		expect(record.raw).toBe(SUB_VENUE)
	})

	it("separates mentioning share-alike from carrying it", () => {
		const prose = readLicenseRecord(SUB_VENUE)
		const grant = readLicenseRecord("ODbL-1.0")

		// The prose row's grant is unknown, so it cannot be said to carry share-alike,
		// and it cannot be said to be free of it either.
		// That distinction is the whole point of two predicates.
		expect(carriesShareAlike(prose)).toBe(false)
		expect(mentionsShareAlike(prose)).toBe(true)

		expect(carriesShareAlike(grant)).toBe(true)
		expect(mentionsShareAlike(grant)).toBe(false)
	})

	it("reads a null or empty value as unresolved rather than as unobliged", () => {
		// 50,000 rows of v0.7.0-de-holdout carry `license: null`.
		for (const value of [null, undefined, ""]) {
			const record = readLicenseRecord(value)

			expect(record.resolution).toBe(LicenseResolution.Unresolved)
			expect(record.expression).toBeNull()
			expect(record.obligations).toEqual([])
		}
	})

	it("finds CC-BY-SA before CC-BY, so a share-alike mention is not read as attribution-only", () => {
		const record = readLicenseRecord("derived from a CC-BY-SA 2.1 JP table")

		expect(record.mentions).toContain("CC-BY-SA-4.0")
		expect(record.mentions).not.toContain("CC-BY-4.0")
		expect(mentionsShareAlike(record)).toBe(true)
	})

	it("treats ODC-By as attribution rather than share-alike", () => {
		// 34,660 rows read "…ancestor pairs from WOF (CC0/ODC-By per source)".
		// ODC-By is the Open Data Commons Attribution License and carries no share-alike term,
		// so it belongs in neither bucket.
		const record = readLicenseRecord(
			"Synthetic — trailing-region; (locality, region) ancestor pairs from WOF (CC0/ODC-By per source)"
		)

		expect(record.mentions).toContain("ODC-By-1.0")
		expect(mentionsShareAlike(record)).toBe(false)
	})

	it("refuses an expression whose identifiers are unrecognized rather than reporting no obligations", () => {
		const record = readLicenseRecord("Totally-Made-Up-1.0")

		expect(record.resolution).toBe(LicenseResolution.Unresolved)
		expect(record.obligations).toEqual([])
	})
})
