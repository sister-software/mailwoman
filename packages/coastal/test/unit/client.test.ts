/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The attribution parse, pinned against the record's own malformed text.
 *
 *   THIS IS A MEASURED TRAP, NOT A HYPOTHETICAL ONE. The 2024 record's abstract carries the attribution
 *   statement TWICE, and the first copy — inherited from the superseded 2018–2021 record — has no year. OGL
 *   v3.0 makes the statement a licence condition, so a parse taking the first match ships a licence condition
 *   stated incorrectly. The fixture below is the real text, read from the Environment Agency's CSW.
 */

import { assertAttributionUnchanged, parseAttributionStatement } from "@mailwoman/coastal/sdk/client"
import { NCERM_ATTRIBUTION, NCERM_SERVICE_SLUG } from "@mailwoman/coastal/vocabulary"
import { describe, expect, it } from "vitest"

/**
 * The tail of the published abstract, verbatim — doubled, with the first copy carrying no year and the whole thing
 * ending in a trailing space.
 */
const PUBLISHED_ABSTRACT_TAIL =
	"…risk may change over time. Attribution statement: © Environment Agency copyright and/or database right  " +
	"Attribution statement: © Environment Agency copyright and/or database right 2025. All rights reserved. "

describe("parseAttributionStatement", () => {
	it("takes the copy carrying a year, not the first one", () => {
		expect(parseAttributionStatement(PUBLISHED_ABSTRACT_TAIL)).toBe(NCERM_ATTRIBUTION)
	})

	it("refuses text in which no copy carries a year", () => {
		expect(() =>
			parseAttributionStatement("Attribution statement: © Environment Agency copyright and/or database right ")
		).toThrow(/carries a year/u)
	})

	it("refuses text carrying no attribution statement at all", () => {
		expect(() => parseAttributionStatement("The data shows areas of land likely to be at erosion risk.")).toThrow(
			/carries a year/u
		)
	})

	it("trims the trailing space the structured field ships", () => {
		expect(parseAttributionStatement(PUBLISHED_ABSTRACT_TAIL).endsWith(" ")).toBe(false)
	})

	it("stops at the closing tag when it is handed the ISO record rather than a bare abstract", () => {
		// The live reader runs over the whole CSW response, so an unbounded lazy capture would run from the last copy to the
		// end of the document and return kilobytes of XML that happens to contain a year.
		const record =
			"<gmd:abstract><gco:CharacterString>" +
			PUBLISHED_ABSTRACT_TAIL +
			"</gco:CharacterString></gmd:abstract><gmd:dateStamp><gco:Date>2025-09-19</gco:Date></gmd:dateStamp>"

		expect(parseAttributionStatement(record)).toBe(NCERM_ATTRIBUTION)
	})
})

describe("assertAttributionUnchanged", () => {
	it("passes the statement this build ships", () => {
		expect(() => assertAttributionUnchanged(NCERM_ATTRIBUTION)).not.toThrow()
	})

	it("refuses a changed statement, because it is a licence condition rather than decoration", () => {
		expect(() =>
			assertAttributionUnchanged("© Environment Agency copyright and/or database right 2026. All rights reserved.")
		).toThrow(/licence condition/u)
	})
})

describe("the service slug", () => {
	it("is the authority's misspelling of its own product", () => {
		// The correct spelling answers HTTP 404 and the misspelling answers HTTP 200. A build that "corrected" this would
		// lose the service half of the two-path verification while reporting a clean run.
		expect(NCERM_SERVICE_SLUG).toBe("ncern-national-2024")
		expect(NCERM_SERVICE_SLUG).not.toContain("ncerm")
	})
})
