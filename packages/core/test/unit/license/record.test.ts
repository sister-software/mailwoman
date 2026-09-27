/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	attributionEntries,
	carriesShareAlike,
	LicenseObligation,
	LicenseResolution,
	licenseNamedIn,
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

	it("resolves the two publisher terms documents that name no SPDX license", () => {
		// Both retrieved 2026-09-27 and retained under internal/strategy/rights-receipts/mx-gb-2026-09-27/.
		// INEGI's document names no Creative Commons license and carries no version,
		// and the ONS licences page spells OGL v3.0 with a dot after the v.
		const inegi = readLicenseRecord("Términos de Libre Uso de la Información del INEGI")
		const ons = readLicenseRecord("Open Government Licence v.3.0")

		expect(inegi.expression).toBe("LicenseRef-INEGI-Terms")
		expect(inegi.obligations).toEqual([LicenseObligation.Attribution])
		expect(carriesShareAlike(inegi)).toBe(false)

		expect(ons.expression).toBe("OGL-UK-3.0")
		expect(ons.obligations).toEqual([LicenseObligation.Attribution])
	})
})

describe("attributionEntries", () => {
	it("takes the first candidate holding at least one string, in the order given", () => {
		expect(attributionEntries(["a", "b"], ["c"])).toEqual(["a", "b"])
		expect(attributionEntries(undefined, ["c"])).toEqual(["c"])
		expect(attributionEntries([], ["c"])).toEqual(["c"])
	})

	it("keeps only the strings in a candidate, and returns an empty list when none holds one", () => {
		expect(attributionEntries([1, "a", null])).toEqual(["a"])
		expect(attributionEntries(undefined, null, "not an array", [1, 2])).toEqual([])
		expect(attributionEntries()).toEqual([])
	})
})

describe("licenseNamedIn", () => {
	it("reads the license out of the parenthetical the cards use", () => {
		expect(licenseNamedIn("LINZ-derived OpenAddresses NZ (CC-BY 4.0): the synth-nz-v2 extract")).toBe("CC-BY 4.0")
		expect(licenseNamedIn("HM Land Registry — Price Paid Data (OGL v3.0): the synth-gb-v1 extract")).toBe("OGL v3.0")
	})

	it("reads a later parenthetical when the first states no license", () => {
		// A dataset's own name carries a parenthetical ahead of the grant's,
		// so a reader taking only the first finds the name.
		// This is the case the `publish-hf.ts` copy of this reader got wrong.
		expect(licenseNamedIn("Overture Maps (the Places theme) (CDLA-Permissive-2.0): names")).toBe("CDLA-Permissive-2.0")
		expect(licenseNamedIn("Korean permit registry (지방행정인허가데이터) (KOGL Type 1): rows")).toBe("KOGL Type 1")
	})

	it("returns null for an entry stating its grant outside every parenthetical", () => {
		// `KOGL Type 1` is the grant and sits in the prose, so this reader finds no license
		// and the caller keeps the verbatim entry.
		// That is a gap to report rather than an answer.
		expect(licenseNamedIn("Korean permit registry (지방행정인허가데이터) under KOGL Type 1")).toBeNull()
	})

	it("returns null for a parenthetical that describes access rather than a grant", () => {
		// The OA PL entry.
		// `public` states that the download costs no fee, which is not a license,
		// and reading it as one would turn the gap this record exists to report into an answer.
		expect(licenseNamedIn("OpenAddresses PL — GUGiK / PRG (public, BDOT-derived): tokenizer-splice text")).toBeNull()
	})

	it("returns null for an entry with no parenthetical at all", () => {
		expect(licenseNamedIn("See THIRD_PARTY_NOTICES.md for the standing attribution.")).toBeNull()
	})

	it("reads the six families the `mailwoman` copy of this reader did not know", () => {
		// PDDL, OGDL, KOGL, CDLA, Etalab and Lizenz were absent from the `publish-hf.ts` list,
		// so a card entry citing one read as stating no license and printed a warning it had not earned.
		for (const family of ["PDDL", "OGDL", "KOGL", "CDLA", "Etalab", "Lizenz"]) {
			expect(licenseNamedIn(`A source (${family}): rows`), family).toBe(family)
		}
	})
})
