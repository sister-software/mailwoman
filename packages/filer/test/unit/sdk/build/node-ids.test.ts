/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The node-identity rules, pinned directly rather than through a whole `filer.db` build.
 *
 *   Every case here is a value that the builder's own suites can only reach by feeding it a row and reading the
 *   artifact back, which means a degenerate node id shows up there as a wrong row count rather than as the identity
 *   collision it is. These assert the mint's output and the shape of what it refuses.
 */

import { describe, expect, it } from "vitest"

import {
	assertLastFiledAt,
	assertProviderValidFrom,
	mintCIKNodeID,
	mintForm499NodeID,
	mintFRNNodeID,
	mintHoldingCompanyNodeID,
	mintManagementCompanyNodeID,
	mintProviderNodeID,
	mintSubsidiaryNameNodeID,
} from "#sdk/build/node-ids"

describe("identifier mints", () => {
	it("namespaces the raw identifier", () => {
		expect(mintFRNNodeID("0001753557", "ctx")).toBe("frn:0001753557")
		expect(mintForm499NodeID("899901", 1)).toBe("form499_id:899901")
		expect(mintCIKNodeID("0000123456", "ctx")).toBe("cik:0000123456")
		expect(mintProviderNodeID(130_317, 1)).toBe("bdc_provider_id:130317")
	})

	it("refuses a blank FRN rather than minting the node every blank row would share", () => {
		expect(() => mintFRNNodeID("", "provider-list row #4")).toThrow(/empty frn/)
		expect(() => mintFRNNodeID("   ", "provider-list row #4")).toThrow(/empty frn/)
		expect(() => mintFRNNodeID("", "provider-list row #4")).toThrow(/provider-list row #4/)
	})

	it("refuses a blank form499ID and names the row", () => {
		expect(() => mintForm499NodeID("", 7)).toThrow(/empty form499ID/)
		expect(() => mintForm499NodeID("\t", 7)).toThrow(/row #7/)
	})

	it("requires the zero-padded 10-digit CIK shape, never padding one itself", () => {
		expect(() => mintCIKNodeID("123456", "edgar row #1")).toThrow(/zero-padded 10-digit/)
		expect(() => mintCIKNodeID("00001234567", "edgar row #1")).toThrow(/zero-padded 10-digit/)
		expect(() => mintCIKNodeID("000012345x", "edgar row #1")).toThrow(/zero-padded 10-digit/)
	})

	it("refuses a providerID that is not a safe integer", () => {
		expect(() => mintProviderNodeID(Number.NaN, 3)).toThrow(TypeError)
		expect(() => mintProviderNodeID(1.5, 3)).toThrow(/safe/)
		expect(() => mintProviderNodeID(Number.MAX_SAFE_INTEGER + 2, 3)).toThrow(/safe/)
	})
})

describe("company-name mints", () => {
	it("carries the raw spelling through unnormalized", () => {
		expect(mintHoldingCompanyNodeID("ACME Holdings,  Inc.")).toBe("holding_company_name:ACME Holdings,  Inc.")
		expect(mintSubsidiaryNameNodeID("Acme Fibre (UK) Ltd")).toBe("subsidiary_name:Acme Fibre (UK) Ltd")
	})

	it("keeps ownership and operational control in separate namespaces for one name", () => {
		expect(mintHoldingCompanyNodeID("Acme Group")).not.toBe(mintManagementCompanyNodeID("Acme Group"))
	})
})

describe("temporal-column guards", () => {
	it("passes a real date through", () => {
		expect(assertLastFiledAt("2026-01-15", "899901", 1)).toBe("2026-01-15")
		expect(assertProviderValidFrom("2026-04-15")).toBe("2026-04-15")
	})

	it("refuses a blank lastFiledAt, which SQLite's NOT NULL would accept", () => {
		expect(() => assertLastFiledAt("", "899901", 2)).toThrow(/empty/)
		expect(() => assertLastFiledAt("   ", "899901", 2)).toThrow(/row #2/)
	})

	it("refuses a vintage LABEL as valid_from", () => {
		expect(() => assertProviderValidFrom("2026-Q2")).toThrow(/ISO YYYY-MM-DD/)
		// Why it has to be refused: string comparison decides at the first differing character, and `Q` outranks
		// every digit — so within its own year the label sorts above every real date and `valid_from <= asOf`
		// never matches.
		const datesInThatYear = ["2026-01-01", "2026-06-30", "2026-12-31"]

		expect(datesInThatYear.every((asOf) => "2026-Q2" > asOf)).toBe(true)
	})

	it("refuses to guess a date when validFrom was omitted", () => {
		expect(() => assertProviderValidFrom(undefined)).toThrow(/options.validFrom is required/)
	})
})
