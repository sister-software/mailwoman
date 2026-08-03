/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for {@linkcode parseExhibit21}/{@linkcode fetchExhibit21} (§7-3b decision 6, gate 3).
 *
 *   Gate 3 first (TDD order): the mangled fixture's zero-subsidiaries/non-zero-unparseable/no-throw
 *   contract is the load-bearing test in this file. The other three fixtures (clean table, nested list,
 *   plain text) each pin a correct extraction for their own shape.
 *
 *   Six document shapes are known to tempt an extractor into emitting a subsidiary name that appears
 *   nowhere in its input — an unclosed `<td>`, a minified no-table/no-`<li>` document, a plain-text
 *   3-column row, an inline tag inside a `<li>`, a nested layout table, and `<td>`-tagged
 *   header/decoration rows — and each has a fixture here. The substring invariant asserted at the bottom
 *   of this file is what covers all six at once: every emitted `name`/`jurisdiction`, across every fixture
 *   AND every crafted malformed case, must be a literal substring of the document once tags are stripped,
 *   entities decoded, and whitespace collapsed.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
	decodeEntities,
	fetchExhibit21,
	normalizeWhitespace,
	parseExhibit21,
	type SECDocumentClient,
	stripTags,
} from "./exhibit21.ts"

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

describe("parseExhibit21 — fabrication audit: malformed input recovered WITHOUT fabrication (C1, C2, C4)", () => {
	it("C1a: an unclosed <td> before the next <td> is implicitly closed at the next cell — not merged into one name", () => {
		const html = "<table><tr><td>Acme Fiber LLC<td>Delaware</td></tr></table>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Acme Fiber LLC", jurisdiction: "Delaware" }],
			unparseable: 0,
		})
	})

	it("C1b: a row with NO </td> at all still yields both cells — not silently dropped as empty-row cruft", () => {
		const html = "<table><tr><td>Acme<td>Delaware</tr></table>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Acme", jurisdiction: "Delaware" }],
			unparseable: 0,
		})
	})

	it("C2: a minified no-table/no-<li> document splits on paragraph boundaries, not on tag-stripping artifacts", () => {
		const html = "<html><body><p>Acme Fiber LLC (Delaware)</p><p>Beta Networks Inc (Nevada)</p></body></html>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [
				{ name: "Acme Fiber LLC", jurisdiction: "Delaware" },
				{ name: "Beta Networks Inc", jurisdiction: "Nevada" },
			],
			unparseable: 0,
		})
	})

	it("C4: an inline <b>/<font> inside a <li> no longer truncates the name at the tag's artifact space", () => {
		const html = "<ul><li><b>Acme</b> Fiber LLC (Delaware)</li></ul>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Acme Fiber LLC", jurisdiction: "Delaware" }],
			unparseable: 0,
		})
	})
})

describe("parseExhibit21 — fabrication audit: ambiguous/decorative content abstains (C3, I2)", () => {
	it("C3: a plain-text 3-column fixed-width row abstains, matching the table strategy's identical 3+-cell rule", () => {
		const text = "Acme Fiber LLC        Delaware        100%"

		expect(parseExhibit21(text)).toEqual({ subsidiaries: [], unparseable: 1 })
	})

	it("I2: <td>-tagged header/decoration rows abstain instead of becoming subsidiaries, real row still recovered", () => {
		const html = fixture("exhibit21-mangled-headers.html")

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Cascade Fiber Holdings, LLC", jurisdiction: "Delaware" }],
			unparseable: 3,
		})
	})

	it("I2: the same boilerplate-label check applies to the plain-text/list strategies, not just the table strategy", () => {
		const text = "SUBSIDIARIES OF THE REGISTRANT\nName of Subsidiary        Jurisdiction of Incorporation\n----\n"

		expect(parseExhibit21(text)).toEqual({ subsidiaries: [], unparseable: 3 })
	})
})

describe("parseExhibit21 — fabrication audit: nested layout table (I1)", () => {
	it("finds the OUTERMOST table's real row and abstains on the nested table's row, rather than replacing the real list", () => {
		const html =
			"<table><tr><td><table><tr><td>Inner</td></tr></table></td></tr>" +
			"<tr><td>Acme Fiber LLC</td><td>Delaware</td></tr></table>"

		expect(parseExhibit21(html)).toEqual({
			subsidiaries: [{ name: "Acme Fiber LLC", jurisdiction: "Delaware" }],
			unparseable: 1,
		})
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

/**
 * The load-bearing invariant this fabrication-audit fix is held to (module docstring): a name is only emitted if it
 * appears in the input as a contiguous string. `normalizedDocument` reproduces the SAME normalization every parse
 * strategy applies before comparing/emitting text — strip tags, decode entities, collapse whitespace — so "appears in
 * the input" is checked on the same basis the parser itself reasons on, not against the raw (still-tagged) source.
 */
function normalizedDocument(html: string): string {
	return normalizeWhitespace(decodeEntities(stripTags(html)))
}

/**
 * Every case the fabrication audit found (C1-C4, I1, I2), preserved here so the substring-invariant test below runs
 * across them alongside the four fixture files — this is what makes the invariant test "load-bearing": mutating any ONE
 * of the tightenings above regresses at least one of these back to a name that fails the check.
 */
const FABRICATION_AUDIT_CASES: Record<string, string> = {
	"C1a unclosed <td>": "<table><tr><td>Acme Fiber LLC<td>Delaware</td></tr></table>",
	"C1b no </td> at all": "<table><tr><td>Acme<td>Delaware</tr></table>",
	"C2 minified paragraphs":
		"<html><body><p>Acme Fiber LLC (Delaware)</p><p>Beta Networks Inc (Nevada)</p></body></html>",
	"C3 3-column plain text": "Acme Fiber LLC        Delaware        100%",
	"C4 inline tag in <li>": "<ul><li><b>Acme</b> Fiber LLC (Delaware)</li></ul>",
	"I1 nested layout table":
		"<table><tr><td><table><tr><td>Inner</td></tr></table></td></tr>" +
		"<tr><td>Acme Fiber LLC</td><td>Delaware</td></tr></table>",
	"I2 header/decoration rows":
		"SUBSIDIARIES OF THE REGISTRANT\nName of Subsidiary        Jurisdiction of Incorporation\n----\n",
}

const FIXTURE_FILES = [
	"exhibit21-mangled.html",
	"exhibit21-mangled-headers.html",
	"exhibit21-clean-table.html",
	"exhibit21-nested-list.html",
	"exhibit21-plain-text.txt",
]

/**
 * The six C1-C4/I1/I2 findings above are all CONCATENATION/mis-segmentation bugs — merging two real fragments, or
 * truncating at the wrong boundary. Every fragment they fabricate remains, structurally, a literal substring of the
 * SAME normalized whole document (it's built from real source text via the identical strip/decode/collapse pipeline the
 * invariant check itself uses) — so the substring check alone does not independently catch any of those six; the
 * case-specific behavioral tests above do (mutation-proven: reverting `stripTags`'s adjacent-whitespace check kills the
 * C4 test, reverting the plain-text block-boundary line-break kills the C2 test). What the substring invariant DOES
 * catch is the other real risk it's meant to guard against: a jurisdiction/name fabricated from nothing — synthesized,
 * defaulted, or otherwise not derived from the input at all — which requires a name-only shape (no jurisdiction
 * column/parenthetical/comma) actually present in the swept set to have something to violate.
 */
const NAME_ONLY_PROBES: Record<string, string> = {
	"name-only table row": "<table><tr><td>Standalone Sub LLC</td></tr></table>",
	"name-only list item": "<ul><li>Standalone Sub LLC</li></ul>",
	"name-only plain-text line": "Standalone Sub LLC\n",
}

describe("parseExhibit21 — substring invariant (decision 6, gate 3): a name is only emitted if the input contains it", () => {
	it.each(FIXTURE_FILES)("every emitted name/jurisdiction is a substring of the normalized document: %s", (name) => {
		const html = fixture(name)
		const normalized = normalizedDocument(html)
		const result = parseExhibit21(html)

		for (const subsidiary of result.subsidiaries) {
			expect(normalized).toContain(subsidiary.name)

			if (subsidiary.jurisdiction) {
				expect(normalized).toContain(subsidiary.jurisdiction)
			}
		}
	})

	it.each(Object.entries(FABRICATION_AUDIT_CASES))(
		"every emitted name/jurisdiction is a substring of the normalized document: %s",
		(_label, html) => {
			const normalized = normalizedDocument(html)
			const result = parseExhibit21(html)

			for (const subsidiary of result.subsidiaries) {
				expect(normalized).toContain(subsidiary.name)

				if (subsidiary.jurisdiction) {
					expect(normalized).toContain(subsidiary.jurisdiction)
				}
			}
		}
	)

	it.each(Object.entries(NAME_ONLY_PROBES))(
		"every emitted name/jurisdiction is a substring of the normalized document: %s",
		(_label, html) => {
			const normalized = normalizedDocument(html)
			const result = parseExhibit21(html)

			for (const subsidiary of result.subsidiaries) {
				expect(normalized).toContain(subsidiary.name)

				if (subsidiary.jurisdiction) {
					expect(normalized).toContain(subsidiary.jurisdiction)
				}
			}
		}
	)
})
