/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { canonicalizeOrganizationName } from "./organization.js"

describe("canonicalizeOrganizationName", () => {
	it("returns null for empty input", () => {
		expect(canonicalizeOrganizationName("")).toBeNull()
		expect(canonicalizeOrganizationName(null)).toBeNull()
		expect(canonicalizeOrganizationName("   ")).toBeNull()
	})

	it("strips legal designations into a comparable key", () => {
		const org = canonicalizeOrganizationName("Acme Corporation, LLC")
		expect(org?.canonical).toBe("acme")
		expect(org?.designations).toEqual(["corporation", "llc"])
	})

	it("collapses Corp / Corporation to the same key", () => {
		expect(canonicalizeOrganizationName("Acme Corp")?.canonical).toBe(
			canonicalizeOrganizationName("Acme Corporation")?.canonical
		)
	})

	it("drops a leading 'The' and a trailing 'Company'", () => {
		const org = canonicalizeOrganizationName("The Coca-Cola Company")
		expect(org?.canonical).toBe("coca cola")
		expect(org?.designations).toEqual(["company"])
	})

	it("expands '&' to 'and' so AT&T and AT and T collide", () => {
		expect(canonicalizeOrganizationName("AT&T Inc.")?.canonical).toBe("at and t")
	})

	it("splits a 'doing business as' clause", () => {
		const org = canonicalizeOrganizationName("Wile E. Holdings LLC dba Acme Rockets")
		expect(org?.canonical).toBe("wile e holdings")
		expect(org?.designations).toEqual(["llc"])
		expect(org?.dba).toBe("acme rockets")
	})

	it("strips diacritics", () => {
		expect(canonicalizeOrganizationName("Nestlé S.A.")?.canonical).toBe("nestle")
	})

	it("preserves the raw input", () => {
		expect(canonicalizeOrganizationName("Acme LLC")?.raw).toBe("Acme LLC")
	})
})

describe("canonicalizeOrganizationName — jurisdiction × domain collisions (#668)", () => {
	it("byte-stable default: never strips collision-prone tokens without context", () => {
		// pt / sca / scs are NOT in the universal base — the legacy behavior keeps them.
		expect(canonicalizeOrganizationName("Lakeside PT")?.canonical).toBe("lakeside pt")
		expect(canonicalizeOrganizationName("Lakeside PT")?.designations).toEqual([])
		expect(canonicalizeOrganizationName("Cardiac SCA Clinic")?.canonical).toBe("cardiac sca clinic")
		// base forms still strip with no options (unchanged).
		expect(canonicalizeOrganizationName("Acme LLC")?.canonical).toBe("acme")
	})

	it("strips PT for an Indonesian jurisdiction (general / no domain)", () => {
		const org = canonicalizeOrganizationName("Maju Bersama PT", { jurisdiction: "ID" })
		expect(org?.canonical).toBe("maju bersama")
		expect(org?.designations).toEqual(["pt"])
		// explicit general domain protects nothing — same result.
		expect(canonicalizeOrganizationName("Maju Bersama PT", { jurisdiction: "ID", domain: "general" })?.canonical).toBe(
			"maju bersama",
		)
	})

	it("jurisdiction code is case-insensitive", () => {
		expect(canonicalizeOrganizationName("Maju Bersama PT", { jurisdiction: "id" })?.designations).toEqual(["pt"])
	})

	it("preserves PT in the healthcare domain", () => {
		const org = canonicalizeOrganizationName("Lakeside PT", { domain: "healthcare" })
		expect(org?.canonical).toBe("lakeside pt")
		expect(org?.designations).toEqual([])
	})

	it("domain protection beats the jurisdiction pack (PT kept for an ID healthcare org)", () => {
		const org = canonicalizeOrganizationName("Maju Bersama PT", { jurisdiction: "ID", domain: "healthcare" })
		expect(org?.canonical).toBe("maju bersama pt")
		expect(org?.designations).toEqual([])
	})

	it("strips French commandite forms (sca / scs) only with the FR jurisdiction", () => {
		expect(canonicalizeOrganizationName("Compagnie Générale SCA", { jurisdiction: "FR" })?.designations).toEqual([
			"sca",
		])
		// but healthcare protects SCA even under FR jurisdiction.
		expect(
			canonicalizeOrganizationName("Cardiac SCA Clinic", { jurisdiction: "FR", domain: "healthcare" })?.canonical,
		).toBe("cardiac sca clinic")
	})

	it("an unknown jurisdiction adds nothing (US keeps base behavior)", () => {
		const org = canonicalizeOrganizationName("Lakeside PT LLC", { jurisdiction: "US" })
		expect(org?.canonical).toBe("lakeside pt") // LLC stripped (base), PT kept (no US pack)
		expect(org?.designations).toEqual(["llc"])
	})
})
