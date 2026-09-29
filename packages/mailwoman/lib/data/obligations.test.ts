/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { obligationFindings, ObligationRefusal, parseObligationRefusals } from "#data"

describe("parseObligationRefusals", () => {
	it("reads repeated flags and a comma-separated variable alike, once each", () => {
		expect(parseObligationRefusals(["share-alike,unresolved", "share-alike"])).toEqual([
			ObligationRefusal.ShareAlike,
			ObligationRefusal.Unresolved,
		])
	})

	it("reads an empty variable as no refusal", () => {
		expect(parseObligationRefusals([""])).toEqual([])
	})

	it("refuses an unknown class rather than ignoring it", () => {
		expect(() => parseObligationRefusals(["share-alike", "copyleft"])).toThrow(/unknown obligation class "copyleft"/)
	})
})

describe("obligationFindings", () => {
	it("names the identifier that carries share-alike, not the expression as a whole", () => {
		const findings = obligationFindings("ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0", [
			ObligationRefusal.ShareAlike,
		])

		expect(findings).toEqual([
			{ refusal: ObligationRefusal.ShareAlike, identifier: "ODbL-1.0", reason: "ODbL-1.0 carries share-alike" },
		])
	})

	it("names an identifier whose obligations are unrecorded under the unresolved class", () => {
		const findings = obligationFindings("LicenseRef-USGov-Public-Domain AND LicenseRef-OpenAddresses-PerSource", [
			ObligationRefusal.Unresolved,
		])

		expect(findings.map((finding) => finding.identifier)).toEqual(["LicenseRef-OpenAddresses-PerSource"])
	})

	it("finds no share-alike in an unresolved identifier, because its obligations are unknown rather than known", () => {
		expect(obligationFindings("LicenseRef-OpenAddresses-PerSource", [ObligationRefusal.ShareAlike])).toEqual([])
	})

	it("finds no identifier when no class is refused", () => {
		expect(obligationFindings("ODbL-1.0", [])).toEqual([])
	})
})
