/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode parseExhibit21}/{@linkcode fetchExhibit21} (3b Task 7, decision 6, gate 3).
 *
 *   Gate 3 first (TDD order): the mangled fixture's zero-subsidiaries/non-zero-unparseable/no-throw
 *   contract is the load-bearing test in this file. The other three fixtures (clean table, nested list,
 *   plain text) each pin a correct extraction for their own shape.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { fetchExhibit21, parseExhibit21, type SECDocumentClient } from "./exhibit21.ts"

function fixture(name: string): string {
	return readFileSync(join(import.meta.dirname, "..", "test-fixtures", name), "utf8")
}

describe("parseExhibit21 — gate 3 (decision 6: abstain, never guess)", () => {
	it("a deliberately mangled fixture yields ZERO subsidiaries, a NON-ZERO unparseable count, and throws nothing", () => {
		const html = fixture("exhibit21-mangled.html")

		expect(() => parseExhibit21(html)).not.toThrow()

		const result = parseExhibit21(html)

		expect(result.subsidiaries).toEqual([])
		expect(result.unparseable).toBeGreaterThan(0)
		expect(result.unparseable).toBe(3)
	})

	it("never throws on a totally empty document", () => {
		expect(() => parseExhibit21("")).not.toThrow()
		expect(parseExhibit21("")).toEqual({ subsidiaries: [], unparseable: 0 })
	})

	it("never throws on a document that is neither a table, a list, nor any recognizable line", () => {
		expect(() => parseExhibit21("<html><body></body></html>")).not.toThrow()
	})
})

describe("parseExhibit21 — clean HTML table", () => {
	it("yields exactly the expected subsidiary list, skipping the header row", () => {
		const html = fixture("exhibit21-clean-table.html")

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [
				{ name: "Cascade Fiber Holdings, LLC", jurisdiction: "Delaware" },
				{ name: "Meridian Broadband, Inc.", jurisdiction: "Nevada" },
				{ name: "Summit Networks Co.", jurisdiction: "Texas" },
			],
			unparseable: 0,
		})
	})

	it("a data row with no jurisdiction column is a name-only subsidiary, not unparseable", () => {
		const html = "<table><tr><td>Standalone Sub LLC</td></tr></table>"

		expect(parseExhibit21(html)).toEqual({ subsidiaries: [{ name: "Standalone Sub LLC" }], unparseable: 0 })
	})

	it("an empty <tr></tr> is skipped as formatting cruft — not a subsidiary, not unparseable", () => {
		const html = "<table><tr></tr><tr><td>Real Sub Inc</td><td>Ohio</td></tr></table>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Real Sub Inc", jurisdiction: "Ohio" }],
			unparseable: 0,
		})
	})

	it("decodes HTML entities inside cells", () => {
		const html = "<table><tr><td>Smith &amp; Sons, LLC</td><td>New York</td></tr></table>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Smith & Sons, LLC", jurisdiction: "New York" }],
			unparseable: 0,
		})
	})
})

describe("parseExhibit21 — nested-list variant", () => {
	it("flattens a nested subsidiary <ul>/<li> tree, each carrying its own name + jurisdiction", () => {
		const html = fixture("exhibit21-nested-list.html")

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [
				{ name: "Cascade Fiber Holdings, LLC", jurisdiction: "Delaware" },
				{ name: "Cascade Last Mile, LLC", jurisdiction: "Nevada" },
				{ name: "Meridian Broadband, Inc.", jurisdiction: "Texas" },
			],
			unparseable: 0,
		})
	})

	it("a list item with no parenthetical jurisdiction is name-only, not unparseable", () => {
		const html = "<ul><li>Standalone Sub LLC</li></ul>"

		expect(parseExhibit21(html)).toEqual({ subsidiaries: [{ name: "Standalone Sub LLC" }], unparseable: 0 })
	})
})

describe("parseExhibit21 — plain-text variant", () => {
	it("splits fixed-width columns on the 2+-space gap", () => {
		const text = fixture("exhibit21-plain-text.txt")

		expect(parseExhibit21(text)).toEqual({
			subsidiaries: [
				{ name: "Cascade Fiber Holdings, LLC", jurisdiction: "Delaware" },
				{ name: "Meridian Broadband, Inc.", jurisdiction: "Nevada" },
				{ name: "Summit Networks Co.", jurisdiction: "Texas" },
			],
			unparseable: 0,
		})
	})

	it("splits on exactly one comma when there is no fixed-width column gap", () => {
		const text = "Acme Fiber LLC, Delaware\n"

		expect(parseExhibit21(text)).toEqual({
			subsidiaries: [{ name: "Acme Fiber LLC", jurisdiction: "Delaware" }],
			unparseable: 0,
		})
	})

	it("does NOT split on 2+ commas — a legal name may itself contain one — and keeps the whole line as the name", () => {
		const text = "Acme Fiber, LLC, Delaware\n"

		const result = parseExhibit21(text)

		expect(result.unparseable).toBe(0)
		expect(result.subsidiaries).toEqual([{ name: "Acme Fiber, LLC, Delaware" }])
	})

	it("blank lines are skipped, never counted as unparseable", () => {
		const text = "Acme Fiber LLC, Delaware\n\n\nBeta Networks, Ohio\n"

		expect(parseExhibit21(text).subsidiaries).toHaveLength(2)
		expect(parseExhibit21(text).unparseable).toBe(0)
	})
})

describe("fetchExhibit21", () => {
	it("fetches through the shared SEC client's getDocument and parses the result", async () => {
		let requestedURL: string | URL | undefined

		const client: SECDocumentClient = {
			getDocument: async (url) => {
				requestedURL = url

				return "<table><tr><td>Fetched Sub LLC</td><td>Delaware</td></tr></table>"
			},
		}

		const result = await fetchExhibit21(client, "https://www.sec.gov/Archives/edgar/data/1/1/ex21.htm")

		expect(requestedURL).toBe("https://www.sec.gov/Archives/edgar/data/1/1/ex21.htm")
		expect(result).toEqual({ subsidiaries: [{ name: "Fetched Sub LLC", jurisdiction: "Delaware" }], unparseable: 0 })
	})
})
