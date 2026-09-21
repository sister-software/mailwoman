/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The source-register build's reader for the three columns the research pass left unresolved.
 *
 *   The register declares `addressRole`, `upstreamLineage` and `coverage` unresolved, and the CSV carries a populated
 *   column for each. Those columns hold `varies` on all 389 rows and `country-specific` on all 389, which is the pass
 *   saying it did not determine the field per source. Carrying either onto a record would turn "nobody looked" into a
 *   value `ingestEligibilityProblems` reads as an answer.
 */

import { readUnresolvedColumn } from "@mailwoman/corpus/tools"
import { describe, expect, it } from "vitest"

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
		// The alternative is dropping it, which is how a column somebody filled in
		// comes to read as a column nobody filled in.
		// The message names both repairs because either can be the right one.
		expect(() => readUnresolvedColumn("head office", "address_role", 42)).toThrow(
			/row 42: address_role "head office" is neither a declared placeholder nor an `AddressRole`/u
		)
	})

	it("does not check a non-role column against the role vocabulary", () => {
		expect(readUnresolvedColumn("head office", "coverage", 42)).toBe("head office")
	})
})
