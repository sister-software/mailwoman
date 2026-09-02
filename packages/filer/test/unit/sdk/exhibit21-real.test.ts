/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file {@linkcode parseExhibit21} against REAL SEC EDGAR Exhibit 21 documents.
 *
 *   `exhibit21.test.ts` covers hand-written fixtures — shapes chosen to exercise a rule. This file covers
 *   thirteen documents pulled off EDGAR on 2026-08-03 and vendored verbatim, including the SGML
 *   `<DOCUMENT>` envelope EDGAR's archive serves them inside. `test-fixtures/edgar/manifest.json` records
 *   where each came from.
 *
 *   The two suites answer different questions, and only this one answers "does it work". At the time this
 *   file was written, the hand-written suite was fully green while these thirteen documents — which state
 *   142 subsidiaries between them — yielded 45, of which 18 were fabricated: EDGAR's own SGML tokens
 *   (`EX-21.1`, the sequence number `3`, the filename `q42025exh211listofsubsidia.htm`), the HTML
 *   `<title>` text `Document`, table header labels (`Entity Name`, `Full Legal Name`), and twelve rows
 *   whose `name` was the bullet character `•` and whose `jurisdiction` was the actual company name.
 *
 *   **`test-fixtures/edgar/expected.json` is ground truth, and it was NOT produced by this parser.** It
 *   comes from an independent DOM-based reference implementation, read line by line against the source
 *   documents. An expectation copied from the implementation under test certifies whatever that
 *   implementation does — including the eight zero-yield documents and the eighteen fabrications above,
 *   every one of which the hand-written suite was happy with. Do not regenerate it from parser output.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { htmlToLayoutText } from "@mailwoman/core/html/text"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { normalizeWhitespace } from "@mailwoman/core/strings/format"
import { parseExhibit21 } from "@mailwoman/filer/sdk/exhibit21"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

interface ExpectedSubsidiary {
	name: string
	jurisdiction?: string
}

interface ExpectedFixtures {
	fixtures: Record<string, { subsidiaries: ExpectedSubsidiary[] }>
}

const FIXTURE_DIRECTORY = resolvePackagePath("@mailwoman/filer", "test-fixtures", "edgar")

// parseJSONStrict, not tryParsingJSON: a corrupt expected.json must fail the suite loudly rather than
// degrade to a fallback, since it IS the contract every assertion below is measured against.
const expected = await readLocalJSONFile<ExpectedFixtures>(join(FIXTURE_DIRECTORY, "expected.json"))

const FIXTURE_NAMES = Object.keys(expected.fixtures).toSorted()

async function fixture(name: string): Promise<string> {
	return await readLocalTextFile(join(FIXTURE_DIRECTORY, name))
}

/**
 * The document as the parser's own preprocessing leaves it — what the substring invariant is measured against.
 */
function normalized(html: string): string {
	return normalizeWhitespace(htmlToLayoutText(html))
}

/**
 * `alti-global-2025.htm` separates its entries with nothing but a double space, so no name/jurisdiction boundary exists
 * to be found. Abstaining entirely is the required answer for it — see `expected.json`'s comment. Every OTHER vendored
 * document states a subsidiary list a reader can follow, so zero is a parser failure there, not an abstention.
 */
const EXPECTED_TO_ABSTAIN_ENTIRELY = new Set(["alti-global-2025.htm"])

describe("parseExhibit21 — real EDGAR filings", () => {
	it.each(FIXTURE_NAMES)("%s reproduces the subsidiary list the document states", async (name) => {
		const result = parseExhibit21(await fixture(name))

		expect(result.subsidiaries).toEqual(expected.fixtures[name]!.subsidiaries)
	})

	it.each(FIXTURE_NAMES)("%s never throws, and counts what it abstained from", async (name) => {
		const result = parseExhibit21(await fixture(name))

		expect(Number.isInteger(result.unparseable)).toBe(true)
		expect(result.unparseable).toBeGreaterThanOrEqual(0)
	})

	it.each(FIXTURE_NAMES.filter((name) => !EXPECTED_TO_ABSTAIN_ENTIRELY.has(name)))(
		"%s yields at least one subsidiary",
		async (name) => {
			expect(parseExhibit21(await fixture(name)).subsidiaries.length).toBeGreaterThan(0)
		}
	)

	it("recovers 142 subsidiaries across the corpus", async () => {
		let total = 0

		for (const name of FIXTURE_NAMES) {
			total += parseExhibit21(await fixture(name)).subsidiaries.length
		}

		expect(total).toBe(142)
	})
})

describe("parseExhibit21 — real EDGAR filings, fabrication audit", () => {
	/**
	 * Each of these was emitted as a subsidiary name by the 2026-08-03 run. They are all literal substrings of their
	 * document, so the substring invariant admits every one of them — which is exactly why this assertion exists
	 * separately from it.
	 */
	const NEVER_A_SUBSIDIARY_NAME = [
		/^ex-?21(\.\d+)?$/i,
		/^\d{1,3}$/,
		/^[\w.-]+\.(htm|html|txt)$/i,
		/^document$/i,
		/^[•●▪◦∙·*–—-]+$/,
		/^[([]?\d{1,3}[)\]]?$/,
	]

	it.each(FIXTURE_NAMES)(
		"%s emits no SGML envelope token, filename, bullet or footnote marker as a name",
		async (name) => {
			for (const subsidiary of parseExhibit21(await fixture(name)).subsidiaries) {
				for (const pattern of NEVER_A_SUBSIDIARY_NAME) {
					expect(subsidiary.name, `${name}: ${JSON.stringify(subsidiary.name)}`).not.toMatch(pattern)
				}
			}
		}
	)

	it.each(FIXTURE_NAMES)("%s emits no column header as a name or a jurisdiction", async (name) => {
		const HEADER_LABELS = new Set([
			"entity name",
			"legal name",
			"full legal name",
			"name of entity",
			"name of subsidiary",
			"subsidiary",
			"domicile",
			"jurisdiction",
			"state of incorporation",
			"state or country of incorporation",
			"state of incorporation or formation",
			"state of incorporation / organization",
			"conducts business under",
			"name doing business as",
			"% of ownership",
		])

		for (const subsidiary of parseExhibit21(await fixture(name)).subsidiaries) {
			expect(HEADER_LABELS.has(subsidiary.name.toLowerCase()), `${name}: name ${subsidiary.name}`).toBe(false)

			if (subsidiary.jurisdiction) {
				expect(
					HEADER_LABELS.has(subsidiary.jurisdiction.toLowerCase()),
					`${name}: jurisdiction ${subsidiary.jurisdiction}`
				).toBe(false)
			}
		}
	})

	it.each(FIXTURE_NAMES)("%s keeps the substring invariant — nothing assembled, nothing truncated", async (name) => {
		const haystack = normalized(await fixture(name))

		for (const subsidiary of parseExhibit21(await fixture(name)).subsidiaries) {
			expect(haystack, `${name}: name ${JSON.stringify(subsidiary.name)}`).toContain(subsidiary.name)

			if (subsidiary.jurisdiction) {
				expect(haystack, `${name}: jurisdiction ${JSON.stringify(subsidiary.jurisdiction)}`).toContain(
					subsidiary.jurisdiction
				)
			}
		}
	})
})

describe("parseExhibit21 — real EDGAR filings, named regressions", () => {
	it("reads AT&T's second table, which continues the first under no header of its own", async () => {
		const names = parseExhibit21(await fixture("att-2025.htm")).subsidiaries.map((subsidiary) => subsidiary.name)

		expect(names).toContain("Illinois Bell Telephone Company, LLC")
		expect(names).toContain("BellSouth Telecommunications, LLC")
		expect(names).toContain("Cricket Wireless LLC")
	})

	it("reads Cable One through its all-blank spacer column", async () => {
		expect(parseExhibit21(await fixture("cable-one-2025.htm")).subsidiaries).toContainEqual({
			name: "Hargray Communications Group, Inc.",
			jurisdiction: "South Carolina",
		})
	})

	it("reads Shenandoah's block-text list, whose two tables are entirely blank", async () => {
		const names = parseExhibit21(await fixture("shentel-2025.htm")).subsidiaries.map((subsidiary) => subsidiary.name)

		expect(names).toContain("The Chillicothe Telephone Company")
		expect(names).not.toContain("SHENANDOAH TELECOMMUNICATIONS COMPANY AND SUBSIDIARIES")
	})

	it("splits Bandwidth's bulleted 'Name (Jurisdiction)' lines on the parenthetical, not the bullet", async () => {
		expect(parseExhibit21(await fixture("bandwidth-2025.htm")).subsidiaries).toContainEqual({
			name: "Voxbone Telekomunikasyon ve Iletisim Hizmetleri Ticaret Limited Sirketi",
			jurisdiction: "Turkey",
		})
	})

	it("abstains on IDT's two-across name/name table rather than calling one company another's jurisdiction", async () => {
		const result = parseExhibit21(await fixture("idt-2025.htm"))

		for (const subsidiary of result.subsidiaries) {
			expect(subsidiary.jurisdiction ?? "").not.toMatch(/IDT Payment Services/)
		}

		expect(result.subsidiaries.map((subsidiary) => subsidiary.name)).not.toContain("IDT America, Corp. (NJ)")
	})

	it("abstains on Ooma's one cell holding five entities in five <p> blocks", async () => {
		for (const subsidiary of parseExhibit21(await fixture("ooma-2025.htm")).subsidiaries) {
			expect(subsidiary.name).not.toMatch(/FluentStream/)
		}
	})

	it("skips EchoStar's four footnote tables while reading its four-column list", async () => {
		const result = parseExhibit21(await fixture("echostar-2025.htm"))

		expect(result.subsidiaries).toContainEqual({ name: "DISH Wireless L.L.C.", jurisdiction: "Colorado" })

		for (const subsidiary of result.subsidiaries) {
			expect(subsidiary.name).not.toMatch(/^This is a subsidiary of/)
		}
	})
})
