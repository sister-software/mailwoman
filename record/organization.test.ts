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
