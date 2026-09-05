/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	assertAdmissibleLicenseExpression,
	chooseLicenseBranch,
	LicenseObligation,
	licenseIdentifiers,
	summarizeLicense,
} from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

describe("summarizeLicense", () => {
	it("names ODbL's attribution and share-alike", () => {
		const summary = summarizeLicense("ODbL-1.0")

		expect(summary.recognized).toBe(true)
		expect(summary.obligations).toEqual([LicenseObligation.Attribution, LicenseObligation.ShareAlike])
	})

	it("reports an empty obligation list for a public-domain dedication as a statement, not an absence", () => {
		const summary = summarizeLicense("CC0-1.0")

		expect(summary.recognized).toBe(true)
		expect(summary.obligations).toEqual([])
	})

	it("refuses to guess at NOASSERTION or a vendor-suffixed identifier", () => {
		for (const expression of ["NOASSERTION", "PDDL-1.0-USGov-NRCS"]) {
			const summary = summarizeLicense(expression)

			expect(summary.recognized).toBe(false)
			expect(summary.unrecognized).toEqual([expression])
		}
	})

	it("takes the union across an AND and an OR before a branch is chosen", () => {
		const summary = summarizeLicense("AGPL-3.0-only OR LicenseRef-Commercial")

		expect(summary.identifiers).toEqual(["AGPL-3.0-only", "LicenseRef-Commercial"])

		expect(summary.obligations).toEqual([
			LicenseObligation.Attribution,
			LicenseObligation.ShareAlike,
			LicenseObligation.SourceOffer,
		])

		expect(summarizeLicense("(OGL-UK-3.0 AND ODbL-1.0)").obligations).toEqual([
			LicenseObligation.Attribution,
			LicenseObligation.ShareAlike,
		])
	})

	it("keeps a WITH exception attached to its license", () => {
		expect(licenseIdentifiers("Apache-2.0 WITH LLVM-exception AND MIT")).toEqual([
			"Apache-2.0 WITH LLVM-exception",
			"MIT",
		])

		expect(summarizeLicense("Apache-2.0 WITH LLVM-exception").recognized).toBe(true)
	})
})

describe("chooseLicenseBranch", () => {
	const dual = "AGPL-3.0-only OR LicenseRef-Commercial"

	it("applies the open-source branch without a commercial agreement", () => {
		expect(chooseLicenseBranch(dual, { commercialAgreement: false })).toBe("AGPL-3.0-only")
	})

	it("applies the commercial branch when an agreement is present", () => {
		expect(chooseLicenseBranch(dual, { commercialAgreement: true })).toBe("LicenseRef-Commercial")
	})

	it("returns a single-branch expression whole", () => {
		expect(chooseLicenseBranch("ODbL-1.0", { commercialAgreement: true })).toBe("ODbL-1.0")
	})
})

describe("assertAdmissibleLicenseExpression", () => {
	it("admits a known identifier, a defined LicenseRef, NOASSERTION, and expressions over them", () => {
		for (const expression of [
			"AGPL-3.0-only OR LicenseRef-Commercial",
			"LicenseRef-USGov-Public-Domain",
			"NOASSERTION",
			"OGL-UK-3.0",
			"CC-BY-4.0 AND ODbL-1.0",
		]) {
			expect(() => assertAdmissibleLicenseExpression(expression)).not.toThrow()
		}
	})

	it("refuses a vendor-suffixed identifier and a bare phrase, naming the identifier", () => {
		expect(() => assertAdmissibleLicenseExpression("PDDL-1.0-USGov-NRCS", "layer manifest")).toThrow(
			/layer manifest: "PDDL-1.0-USGov-NRCS" is not an admissible/u
		)

		expect(() => assertAdmissibleLicenseExpression("public-domain")).toThrow(/"public-domain"/u)
	})
})
