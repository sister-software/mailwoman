// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { findCountryLiteralSets } from "#repo-health/checks/country/literal-sets"

const SHARED = "packages/corpus/lib/recipes/thing.ts"
const shared = (text: string) => [{ file: SHARED, text }]

describe("findCountryLiteralSets", () => {
	it("reports an array and a Set literal held by a country-named binding", () => {
		const text = [
			`export const CJK_COUNTRIES = new Set(["JP", "CN", "TW", "HK"])`,
			`const ANCHOR_COUNTRIES = ["DE", "FR", "US"] as const`,
			`const table = { countries: ["us", "ca", "mx"] }`,
			``,
		].join("\n")

		expect(findCountryLiteralSets(shared(text))).toEqual([
			{ file: SHARED, line: 1, kind: "literal", text: "CJK_COUNTRIES" },
			{ file: SHARED, line: 2, kind: "literal", text: "ANCHOR_COUNTRIES" },
			{ file: SHARED, line: 3, kind: "literal", text: "countries" },
		])
	})

	it("admits a short list, a subdivision list and a non-code list", () => {
		const text = [
			`const SEED_COUNTRIES = ["US", "GB"]`,
			`const STATES = ["CA", "NY", "TX", "WA"]`,
			`const COUNTRY_NAMES = ["France", "Spain", "Italy"]`,
			``,
		].join("\n")

		expect(findCountryLiteralSets(shared(text))).toEqual([])
	})

	it("reports a literal list passed to countriesDeclaredBy and a cast to CountrySet", () => {
		const text = [
			`const a = countriesDeclaredBy("x", ["US", "FR", "DE"])`,
			`const b = countriesDeclaredBy("x", config.keys)`,
			`const c = new Set(["US"]) as unknown as CountrySet<{ world: true }>`,
			``,
		].join("\n")

		expect(findCountryLiteralSets(shared(text)).map(({ line, kind }) => [line, kind])).toEqual([
			[1, "declared"],
			[3, "cast"],
		])
	})

	it("admits a marked list, including a marker above its doc comment", () => {
		const text = [
			`// country-branch: the country list of one source's corpora. Its manifests would replace it.`,
			`/**`,
			` * Countries one family reads.`,
			` */`,
			`export const FAMILY_COUNTRIES = ["JP", "CN", "KR"]`,
			``,
		].join("\n")

		expect(findCountryLiteralSets(shared(text))).toEqual([])
	})

	it("admits every list in a country home, and a cast in the module that defines the brand", () => {
		expect(
			findCountryLiteralSets([
				{
					file: "packages/codex/lib/country/writing-systems.ts",
					text: `export const COUNTRIES = ["US", "FR", "DE"]\n`,
				},
				{ file: "packages/corpus/lib/fr/regions.ts", text: `const COUNTRIES = ["FR", "MC", "AD"]\n` },
				{ file: "packages/codex/lib/country/sets.ts", text: `const s = x as CountrySet<Spec>\n` },
			])
		).toEqual([])
	})
})
