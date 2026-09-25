/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the CIK corroboration check.
 *
 *   The CIK and SIC fixtures come from EDGAR's submissions API.
 */

import { CIKCorroborationBasis, corroborateCIK, TELECOM_SIC_CODES } from "@mailwoman/filer/sdk/cik-corroboration"
import { toCIK, type CIK } from "@mailwoman/filer/sdk/edgar-filings"
import { describe, expect, it } from "vitest"

const cik = (value: string): CIK => toCIK(value)!

/**
 * Each entry holds a label, CIK, SIC and the expected corroboration result.
 */
const REGISTRANTS: ReadonlyArray<readonly [string, string, string, boolean]> = [
	["Lumen Technologies", "0000018926", "4813", true],
	["Anterix", "0001304492", "4813", true],
	["IDT", "0001005731", "4813", true],
	["Cable One", "0001632127", "4841", true],
	["Liberty Broadband", "0001611983", "4841", true],
	["Gogo", "0001537054", "4899", true],
	// These two are wrong companies that name matching scored highly.
	["AlTi Global (matched 'Altice USA')", "0001838615", "6282", false],
	["WidePoint (matched 'WideOpenWest')", "0001034760", "7373", false],
	// These are real carriers filed under software SIC codes.
	// The check rejects them by design.
	["Bandwidth", "0001514416", "7372", false],
	["Ooma", "0001327688", "7374", false],
]

describe("corroborateCIK — against the measured corpus", () => {
	it.each(REGISTRANTS)("%s (SIC %s) → corroborated=%s", (_label, value, sic, expected) => {
		expect(corroborateCIK(cik(value), sic).corroborated).toBe(expected)
	})

	it("rejects both false matches, which is the whole point", () => {
		expect(corroborateCIK(cik("0001838615"), "6282")).toEqual({
			corroborated: false,
			basis: CIKCorroborationBasis.NonTelecomSIC,
			sic: "6282",
		})

		expect(corroborateCIK(cik("0001034760"), "7373").corroborated).toBe(false)
	})

	it("accepts 6 of the 8 real carriers and rejects 2 — the cost, stated", () => {
		const real = REGISTRANTS.filter(([label]) => !label.includes("matched"))
		const accepted = real.filter(([, value, sic]) => corroborateCIK(cik(value), sic).corroborated)

		expect(real).toHaveLength(8)
		expect(accepted).toHaveLength(6)
	})
})

describe("corroborateCIK — pins", () => {
	it("admits a pinned CIK whose SIC would otherwise reject it", () => {
		const pinnedCIKs = new Set([cik("0001514416")])

		expect(corroborateCIK(cik("0001514416"), "7372", { pinnedCIKs })).toEqual({
			corroborated: true,
			basis: CIKCorroborationBasis.Pinned,
		})
	})

	it("checks the pin BEFORE the SIC, so a pin is a decision rather than a tiebreak", () => {
		// A pin applies even when the SIC is missing.
		const pinnedCIKs = new Set([cik("0001514416")])

		expect(corroborateCIK(cik("0001514416"), null, { pinnedCIKs }).basis).toBe(CIKCorroborationBasis.Pinned)
	})

	it("does not admit a DIFFERENT CIK just because some pin exists", () => {
		const pinnedCIKs = new Set([cik("0001514416")])

		expect(corroborateCIK(cik("0001034760"), "7373", { pinnedCIKs }).corroborated).toBe(false)
	})
})

describe("corroborateCIK — abstention is not denial", () => {
	it("reports a missing SIC as its own basis, distinct from a rejecting one", () => {
		for (const absent of [null, undefined, "", "   "]) {
			expect(corroborateCIK(cik("0000018926"), absent)).toEqual({
				corroborated: false,
				basis: CIKCorroborationBasis.NoSIC,
			})
		}
	})

	it("carries the SIC it actually consulted, so a report can name it", () => {
		expect(corroborateCIK(cik("0000018926"), "4813").sic).toBe("4813")
		expect(corroborateCIK(cik("0001838615"), "6282").sic).toBe("6282")
	})

	it("tolerates surrounding whitespace rather than reading it as a different code", () => {
		expect(corroborateCIK(cik("0000018926"), " 4813 ").corroborated).toBe(true)
	})
})

describe("the allowlist itself", () => {
	it("is enumerated, not a 48xx prefix test — 4899 is in, 4813 is in, 4899's neighbours are not", () => {
		expect(TELECOM_SIC_CODES.has("4813")).toBe(true)
		expect(TELECOM_SIC_CODES.has("4899")).toBe(true)
		// A 48xx prefix rule would accept these codes.
		expect(TELECOM_SIC_CODES.has("4800")).toBe(false)
		expect(TELECOM_SIC_CODES.has("4890")).toBe(false)
	})

	it("excludes the software classifications, because including them readmits WidePoint", () => {
		// Carriers under these codes need an explicit pin.
		for (const sic of ["7372", "7373", "7374"]) {
			expect(TELECOM_SIC_CODES.has(sic)).toBe(false)
		}
	})

	it("is overridable for another vertical without forking the check", () => {
		const acceptedSICCodes = new Set(["6282"])

		expect(corroborateCIK(cik("0001838615"), "6282", { acceptedSICCodes }).corroborated).toBe(true)
		expect(corroborateCIK(cik("0000018926"), "4813", { acceptedSICCodes }).corroborated).toBe(false)
	})
})
