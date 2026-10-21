/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { declarationExpiry, expiryForIntent, nearestQuarterLead, plusMonths } from "#expiry"

describe("plusMonths", () => {
	it("adds calendar months and lets a day past the month's end roll forward", () => {
		expect(plusMonths("2026-10-21", 4)).toBe("2027-02-21")
		expect(plusMonths("2026-10-31", 4)).toBe("2027-03-03")
		expect(plusMonths("2026-12-25", 4)).toBe("2027-04-25")
	})
})

describe("nearestQuarterLead", () => {
	it("picks the lead date nearest the target", () => {
		expect(nearestQuarterLead("2027-02-21")).toBe("2027-03-11")
		expect(nearestQuarterLead("2026-12-20")).toBe("2026-12-11")
	})

	it("gives a tie to the later lead date", () => {
		// 2027-04-25 is 45 days after 03-11 and 46 days before 06-10. 2027-04-26 is 46 after and 45 before.
		expect(nearestQuarterLead("2027-04-25")).toBe("2027-03-11")
		expect(nearestQuarterLead("2027-04-26")).toBe("2027-06-10")
		// 2027-01-25 is 45 days after 2026-12-11 and 45 days before 2027-03-11.
		expect(nearestQuarterLead("2027-01-25")).toBe("2027-03-11")
	})
})

describe("declarationExpiry", () => {
	it.each([
		["2026-10-21", "2027-03-11"],
		["2026-12-25", "2027-03-11"],
		["2026-12-27", "2027-06-10"],
		["2027-02-20", "2027-06-10"],
		["2026-10-31", "2027-03-11"],
	])("issued %s expires %s", (issued, expires) => {
		expect(declarationExpiry(issued)).toBe(expires)
	})
})

describe("expiryForIntent", () => {
	it("gives an evaluation thirty days, an academic or student token a year, and a declaration the quarter rule", () => {
		expect(expiryForIntent("evaluation", "2026-10-21")).toBe("2026-11-20")
		expect(expiryForIntent("academic", "2026-10-21")).toBe("2027-10-21")
		expect(expiryForIntent("student", "2026-10-21")).toBe("2027-10-21")
		expect(expiryForIntent("open-source", "2026-10-21")).toBe("2027-03-11")
		expect(expiryForIntent("non-profit", "2026-10-21")).toBe("2027-03-11")
	})

	it("refuses the commercial intent, whose expiry the billing period decides", () => {
		expect(() => expiryForIntent("commercial", "2026-10-21")).toThrow(/billing period/u)
	})
})
