/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { extractRecords } from "./extract.ts"

function page(article: string, head = ""): string {
	return `<html><head>${head}</head><body>
		<nav><a class="menu__link menu__link--sublist menu__link--active">Reference</a></nav>
		<article>${article}</article></body></html>`
}

describe("extractRecords", () => {
	test("starts a record at each heading and aggregates the text below it", () => {
		const records = extractRecords(
			page(`<h1>Decoder</h1><p>Intro text.</p><h2 id="objective">Objective</h2><p>First.</p><ul><li>Second.</li></ul>`),
			"/docs/decoder"
		)

		expect(records.map((record) => [record.level, record.anchor, record.content])).toEqual([
			[1, "", "Intro text."],
			[2, "objective", "First. Second."],
		])

		expect(records[1]?.hierarchy).toEqual(["Reference", "Decoder", "Objective", null, null, null, null])
		expect(records.map((record) => record.position)).toEqual([0, 1])
	})

	test("yields one level-5 record per table row, under the enclosing heading", () => {
		const records = extractRecords(
			page(`<h1>Coverage</h1><h2 id="rows">Rows</h2><table><tbody>
				<tr><td>Norway</td><td>ignored middle</td><td>Elected</td></tr>
				<tr><td>Sweden</td><td>x</td><td>Refused</td></tr></tbody></table>`),
			"/docs/coverage"
		)

		const rows = records.filter((record) => record.level === 5)

		expect(rows.map((record) => [record.hierarchy[5], record.content, record.anchor])).toEqual([
			["Norway", "Elected", "rows"],
			["Sweden", "Refused", "rows"],
		])

		expect(rows[0]?.hierarchy.slice(0, 3)).toEqual(["Reference", "Coverage", "Rows"])
	})

	test("resets deeper hierarchy entries when a shallower heading follows", () => {
		const records = extractRecords(page(`<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>`), "/docs/a")

		expect(records.at(-1)?.hierarchy).toEqual(["Reference", "A", "D", null, null, null, null])
	})

	test("counts a list item's paragraph text once", () => {
		const records = extractRecords(page(`<h1>A</h1><ul><li><p>Once.</p></li></ul>`), "/docs/a")

		expect(records[0]?.content).toBe("Once.")
	})

	test("counts a table cell's paragraph and list text only in the row record", () => {
		const records = extractRecords(
			page(`<h1>A</h1><p>Above.</p><table><tbody>
				<tr><td>Norway</td><td><p>Elected.</p> <ul><li>Notes.</li></ul></td></tr></tbody></table>`),
			"/docs/a"
		)

		expect(records.map((record) => [record.level, record.content])).toEqual([
			[1, "Above."],
			[5, "Elected. Notes."],
		])
	})

	test("gives distinct ids to headings that share an id or have none", () => {
		const records = extractRecords(page(`<h1>A</h1><h2 id="x">B</h2><h2 id="x">C</h2><h2>D</h2>`), "/docs/a")

		expect(new Set(records.map((record) => record.id)).size).toBe(records.length)
	})

	test("gives the same id to the same heading across builds", () => {
		const first = extractRecords(page(`<h1>A</h1><p>one</p>`), "/docs/a")
		const changed = extractRecords(page(`<h1>A</h1><p>two</p>`), "/docs/a")

		expect(changed[0]?.id).toBe(first[0]?.id)
	})

	test("uses the default category when the page marks no active sidebar entry", () => {
		const records = extractRecords(`<html><body><article><h1>A</h1></article></body></html>`, "/a")

		expect(records[0]?.hierarchy[0]).toBe("Documentation")
	})

	test("yields zero records for a noindex page and for a page without an article", () => {
		expect(extractRecords(page(`<h1>A</h1>`, `<meta name="robots" content="noindex, nofollow">`), "/a")).toEqual([])
		expect(extractRecords(`<html><body><h1>A</h1></body></html>`, "/a")).toEqual([])
	})

	test("drops a heading's hash link and its zero-width space from the heading text", () => {
		const records = extractRecords(
			page(
				`<h1>A</h1><h2 class="anchor" id="scope">Scope<a href="#scope" class="hash-link" aria-label="Direct link to Scope">​</a></h2>`
			),
			"/docs/a"
		)

		expect(records[1]?.hierarchy[2]).toBe("Scope")
		expect(records.flatMap((record) => [...record.hierarchy, record.content]).join("")).not.toMatch(/​/)
	})

	test("reads a glossary term once and leaves its tooltip definition out", () => {
		const records = extractRecords(
			page(
				`<h1>A</h1><p>A <span class="glossary-term-wrapper"><span><a class="glossaryTerm" href="/glossary#locale">locale</a><span role="tooltip"><strong>locale</strong>The combination of language and country.</span></span></span> is chosen.</p>`
			),
			"/docs/a"
		)

		expect(records[0]?.content).toBe("A locale is chosen.")
	})

	test("joins a table row keyed by a number to the section instead of making it a record", () => {
		const records = extractRecords(
			page(`<h1>Tiers</h1><h2 id="tiers">Tiers</h2><table><tbody>
				<tr><td>1</td><td>Trained, with a regression bar.</td></tr>
				<tr><td>Norway</td><td>Elected</td></tr></tbody></table>`),
			"/docs/tiers"
		)

		expect(records.filter((record) => record.level === 5).map((record) => record.hierarchy[5])).toEqual(["Norway"])
		expect(records[1]?.content).toBe("1 Trained, with a regression bar.")
	})
})
