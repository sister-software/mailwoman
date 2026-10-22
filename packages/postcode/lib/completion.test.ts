/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import type { PostcodePrefixNode } from "@mailwoman/core/resolver"
import { describe, expect, test } from "vitest"

import { canComplete } from "#completion"
import { acceptPostcode, postcodeSyntax } from "#country-formats"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#country-formats/data"
import { PrefixAutomaton } from "#prefix-automaton"
import { PostcodePrefixIndexResolver, serializePostcodePrefixIndex, type PostcodePrefixHeader } from "#prefix-index"

const COUNTRIES = Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)

const syntaxOnly = (text: string, country: string): boolean => canComplete(text, { countries: country }).canComplete

/**
 * Every prefix of `value`, from the empty string to the whole value.
 */
function prefixes(value: string): string[] {
	return Array.from({ length: value.length + 1 }, (_, n) => value.slice(0, n))
}

async function readExamples(): Promise<Map<string, string[]>> {
	const dir = resolvePackageDirectory("@mailwoman/dictionaries")("data", "chromium-i18n", "ssl-address")
	const examples = new Map<string, string[]>()

	for (const country of COUNTRIES) {
		const metadata = await readLocalJSONFile<{ readonly zipex?: string }>(dir(`${country}.json`))

		examples.set(country, metadata.zipex ? metadata.zipex.split(",") : [])
	}

	return examples
}

describe("PrefixAutomaton", () => {
	test.each(COUNTRIES)("compiles %s's syntax and accepts the empty prefix", (country) => {
		const automaton = new PrefixAutomaton(postcodeSyntax(country)!.pattern.source)

		expect(automaton.canComplete("")).toBe(true)
	})

	test("refuses a construct outside the supported subset", () => {
		expect(() => new PrefixAutomaton("(?=a)b")).toThrow(/unsupported group/u)
		expect(() => new PrefixAutomaton("\\p{L}")).toThrow(/unsupported escape/u)
	})
})

describe("canComplete over libaddressinput's examples", async () => {
	const examples = await readExamples()

	test("every country with a syntax rule has at least one example", () => {
		expect(COUNTRIES.filter((country) => !examples.get(country)?.length)).toEqual([])
	})

	test.each(COUNTRIES)("%s accepts every prefix of each of its own examples", (country) => {
		for (const example of examples.get(country)!) {
			// The example must be whole under the syntax, or the prefix test below is not about this rule.
			expect(acceptPostcode(example, country), example).not.toBeNull()

			for (const prefix of prefixes(example)) {
				expect(syntaxOnly(prefix, country), `${country} "${prefix}"`).toBe(true)
			}

			expect(canComplete(example, { countries: country }).syntax).toEqual([{ country, complete: true }])
		}
	})

	test.each(COUNTRIES)("%s refuses each example with a character no rule admits appended", (country) => {
		for (const example of examples.get(country)!) {
			expect(syntaxOnly(`${example}#`, country), example).toBe(false)
		}
	})
})

describe("canComplete counterexamples", () => {
	test.each([
		["12A", "US"],
		["1234A", "US"],
		["12345-12345", "US"],
		["123456", "DE"],
		["1A", "DE"],
		["SW1A 1A1", "GB"],
		["1SW", "GB"],
		["ZZ1", "GB"],
		["0123", "NL"],
		["1234 SA", "NL"],
		["1234 A1", "NL"],
		["D1A", "CA"],
		["MD-20011", "MD"],
		["L", "US"],
	])("%s cannot complete in %s", (text, country) => {
		expect(syntaxOnly(text, country)).toBe(false)
	})
})

describe("written forms", () => {
	test.each(prefixes("12345-6789").concat(prefixes("12345 6789"), prefixes("123456789")))(
		"US ZIP+4 prefix %j completes, with or without a separator",
		(text) => {
			expect(syntaxOnly(text, "US")).toBe(true)
		}
	)

	test("a nine-digit ZIP+4 is whole and a ten-digit run is not completable", () => {
		expect(canComplete("123456789", { countries: "US" }).syntax).toEqual([{ country: "US", complete: true }])
		expect(syntaxOnly("1234567890", "US")).toBe(false)
	})

	test.each(["SW1A", "SW1A ", "SW1A 1", "SW1A 1A", "M1", "M11", "EC1Y8S", "GIR 0", "BFPO 6"])(
		"GB outward or partial inward %j completes",
		(text) => {
			expect(syntaxOnly(text, "GB")).toBe(true)
		}
	)

	test("a GB outward code alone is not yet whole; outward plus inward is", () => {
		expect(canComplete("SW1A", { countries: "GB" }).syntax).toEqual([{ country: "GB", complete: false }])
		expect(canComplete("SW1A 1AA", { countries: "GB" }).syntax).toEqual([{ country: "GB", complete: true }])
		expect(canComplete("SW1A1AA", { countries: "GB" }).syntax).toEqual([{ country: "GB", complete: true }])
	})

	test.each(prefixes("1234 AB").concat(prefixes("1234AB"), prefixes("1234ab")))(
		"NL prefix %j completes with or without the space",
		(text) => {
			expect(syntaxOnly(text, "NL")).toBe(true)
		}
	)

	test("a layout prefix may be partly typed or typed whole", () => {
		expect(syntaxOnly("M", "MD")).toBe(true)
		expect(syntaxOnly("MD-", "MD")).toBe(true)
		expect(syntaxOnly("md-20", "MD")).toBe(true)
	})

	test("trailing whitespace counts only where the syntax admits it or the code is whole", () => {
		expect(syntaxOnly("10115 ", "DE")).toBe(true)
		expect(syntaxOnly("1011 ", "DE")).toBe(false)
		expect(syntaxOnly("1234 ", "NL")).toBe(true)
	})
})

describe("candidate countries", () => {
	test("lists every country whose syntax admits the prefix when no country is given", () => {
		const answer = canComplete("9021")
		const countries = answer.syntax.map((s) => s.country)

		expect(countries).toContain("US")
		expect(countries).toContain("DE")
		expect(countries).not.toContain("GB")
		expect(answer.membership).toBeNull()
	})

	test("reports a candidate with no stated syntax separately rather than as a refusal", () => {
		const answer = canComplete("12", { countries: ["AE", "US"] })

		expect(answer.withoutSyntax).toEqual(["AE"])
		expect(answer.syntax).toEqual([{ country: "US", complete: false }])
	})
})

describe("membership", () => {
	const header: PostcodePrefixHeader = {
		country: "gb",
		scope: "gb-esw",
		schemaVersion: 1,
		levels: ["outward"],
		source: "test",
		sourceMD5s: [],
		buildDate: "2026-10-21T00:00:00.000Z",
		tier: "shipped",
		attribution: "test",
		coverageNote: "England, Scotland and Wales only.",
	}

	const node = (prefix: string): PostcodePrefixNode => ({
		prefix,
		ancestors: [],
		lat: null,
		lon: null,
		radiusP95Km: null,
		unitCount: 1,
	})

	const index = new PostcodePrefixIndexResolver(serializePostcodePrefixIndex(header, [node("SW1A"), node("M1")]))

	test("reports observed, unobserved and out of coverage beside the syntax answer", () => {
		const options = { countries: ["GB", "US"], prefixIndexes: [index] }

		expect(canComplete("SW1", options).membership).toEqual([
			{ country: "GB", evidence: "observed", scopes: ["gb-esw"], coverageNotes: [header.coverageNote] },
		])

		expect(canComplete("m1 1aa", options).membership?.[0]?.evidence).toBe("observed")
		expect(canComplete("ZE1", options).membership?.[0]?.evidence).toBe("unobserved")

		expect(canComplete("1", options).membership).toEqual([
			{ country: "US", evidence: "out-of-coverage", scopes: [], coverageNotes: [] },
		])
	})

	test("an unobserved prefix keeps its syntax answer", () => {
		const answer = canComplete("ZE1", { countries: "GB", prefixIndexes: [index] })

		expect(answer.canComplete).toBe(true)
		expect(answer.syntax).toEqual([{ country: "GB", complete: false }])
	})
})
