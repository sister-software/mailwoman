/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The source-register build's reader for the columns the research pass left unresolved, and the
 *   merge of the reviews that resolve them.
 *
 *   The CSV holds a populated `address_role`, `coverage` and `upstream` column and resolves none of them:
 *   all 389 non-rail rows read `varies`, `country-specific` and the empty string. A value copied from one of
 *   those columns would turn "uninspected" into a value `ingestEligibilityProblems` reads as an answer. A
 *   review records its findings in `source-resolutions.json`, and `applySourceResolutions` merges them.
 */

import { describe, expect, it } from "vitest"

import type { AddressSourceRecord } from "#source-register"
import { applySourceResolutions, readUnresolvedColumn } from "#tools"
import { AddressRole } from "#types"

describe("readUnresolvedColumn", () => {
	it("reads a declared placeholder as unresolved, whatever its case", () => {
		expect(readUnresolvedColumn("varies", "address_role", 1)).toBeUndefined()
		expect(readUnresolvedColumn("Varies", "address_role", 1)).toBeUndefined()
		expect(readUnresolvedColumn("country-specific", "coverage", 1)).toBeUndefined()
	})

	it("reads an empty or absent column as unresolved", () => {
		expect(readUnresolvedColumn("", "upstream", 1)).toBeUndefined()
		expect(readUnresolvedColumn("   ", "upstream", 1)).toBeUndefined()
		expect(readUnresolvedColumn(undefined, "upstream", 1)).toBeUndefined()
	})

	it("returns a value somebody resolved", () => {
		expect(readUnresolvedColumn("premise", "address_role", 1)).toBe("premise")
		expect(readUnresolvedColumn("Apr 2007 through Sep 2026", "coverage", 1)).toBe("Apr 2007 through Sep 2026")
	})

	it("refuses an address_role that is neither a placeholder nor a role", () => {
		// Its omission would make a column someone filled in read as a column with no recorded value.
		// The message names both repairs because either can be the right one.
		expect(() => readUnresolvedColumn("head office", "address_role", 42)).toThrow(
			/row 42: address_role "head office" is neither a declared placeholder nor an `AddressRole`/u
		)
	})

	it("does not check a non-role column against the role vocabulary", () => {
		expect(readUnresolvedColumn("head office", "coverage", 42)).toBe("head office")
	})
})

describe("applySourceResolutions", () => {
	const source: AddressSourceRecord = {
		sourceID: "zz-health-1",
		iso2: "ZZ",
		sector: "health",
		name: "Testland facility register",
		status: "verified-corpus",
		asserts: ["identity", "observation"],
		authorityBasis: "national health ministry",
		geometry: "unresolved",
		license: "unchecked-test",
		researchPass: "2026-09-18-web-research",
	}

	it("merges a recorded resolution onto the source it names and leaves the others alone", () => {
		const other: AddressSourceRecord = { ...source, sourceID: "zz-health-2" }

		const [resolved, untouched] = applySourceResolutions(
			[source, other],
			new Map([
				[
					"zz-health-1",
					{
						addressRoles: { "facility.address": AddressRole.Facility },
						coverage: "measured national, 2026-09",
						upstreamLineage: ["https://example.invalid/api"],
						personalDataReview: {
							reading: "absent" as const,
							because: "every row names a licensed facility rather than a person",
						},
					},
				],
			])
		)

		expect(resolved!.addressRoles).toEqual({ "facility.address": "facility" })
		expect(resolved!.coverage).toBe("measured national, 2026-09")
		expect(resolved!.upstreamLineage).toEqual(["https://example.invalid/api"])
		expect(resolved!.personalDataReview?.reading).toBe("absent")

		// The merge replaces only the resolved fields, so the CSV-derived ones stay.
		expect(resolved!.authorityBasis).toBe("national health ministry")
		expect(untouched).toEqual(other)
	})

	it("returns the rows unchanged when no resolution is recorded", () => {
		expect(applySourceResolutions([source], new Map())).toEqual([source])
	})

	it("refuses a resolution naming a source the register does not carry", () => {
		// A kept entry would leave a review whose fields reach no row.
		// That reads as work already done.
		expect(() => applySourceResolutions([source], new Map([["zz-health-9", { coverage: "measured" }]]))).toThrow(
			/a recorded source resolution names "zz-health-9", which the register does not carry/u
		)
	})
})
