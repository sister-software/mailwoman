// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import { countryBranchesCheck, isCountryHome } from "#repo-health/checks/country/branches"

const SHARED = "packages/corpus/lib/recipes/thing.ts"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Runs the check over fixture files and returns each finding as `file:line form`.
 */
async function reported(files: Record<string, string>): Promise<string[]> {
	const root = fixtures.use(await temporaryDirectory("country-branches-")).path

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(root(file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, root(file))
	}

	const diagnostics = await countryBranchesCheck.run({ repoRoot: root.toString(), trackedFiles: Object.keys(files) })

	return diagnostics
		.map(
			(diagnostic) =>
				`${diagnostic.file}:${diagnostic.line} ${/\((?<form>[a-z-]+)\)\. Move/u.exec(diagnostic.message)?.groups?.form ?? "default"}`
		)
		.toSorted()
}

/**
 * The findings for the lines of one shared module, as `line form`.
 */
async function reportedLines(lines: readonly string[]): Promise<string[]> {
	const found = await reported({ [SHARED]: `${lines.join("\n")}\n` })

	return found.map((finding) => finding.slice(SHARED.length + 1))
}

describe("isCountryHome", () => {
	it("admits a country directory, a country file name and the codex", () => {
		expect(isCountryHome("packages/corpus/lib/us/adapters/tiger/adapter.ts")).toBe(true)
		expect(isCountryHome("packages/gazetteer/tools/pipeline/postcode/locality/jp.ts")).toBe(true)
		expect(isCountryHome("packages/mailwoman/tools/dev-tools/gb/probe.run.ts")).toBe(true)
		expect(isCountryHome("packages/codex/lib/country.ts")).toBe(true)
	})

	it("refuses a shared module", () => {
		expect(isCountryHome("packages/corpus/lib/recipes/venue.ts")).toBe(false)
		expect(isCountryHome("packages/corpus/lib/synthesizers/utils.ts")).toBe(false)
	})

	it("refuses two letters that are no country, or a country's letters outside a workspace source root", () => {
		// FS, OA, EM and DB are no ISO 3166-1 codes.
		expect(isCountryHome("packages/core/lib/fs/readers.ts")).toBe(false)
		expect(isCountryHome("packages/mailwoman/tools/eval-harness/oa/sample.ts")).toBe(false)
		expect(isCountryHome("packages/match/lib/em.ts")).toBe(false)
		expect(isCountryHome("packages/sqlite/lib/sealed/db.ts")).toBe(false)
		// CI is Côte d'Ivoire's code, and this directory holds continuous-integration helpers.
		expect(isCountryHome("lib/repo-health/ci/annotations.ts")).toBe(false)
		expect(isCountryHome("packages/recognizer/lib/ir.ts")).toBe(false)
	})
})

describe("countryBranchesCheck", () => {
	it("reports an uppercase code compared with a country operand, whatever prefix the name has", async () => {
		await expect(
			reportedLines([
				`if (tuple.country === "US") skip()`,
				`if ("GB" !== rowISO2) skip()`,
				`if (hint.countryCode == "FR") skip()`,
			])
		).resolves.toEqual(["1 comparison", "2 comparison", "3 comparison"])
	})

	it("reports a lowercase code and a case-folded operand", async () => {
		await expect(
			reportedLines([
				`const slug = country === "fr" ? "fr" : "us"`,
				`if (query.country?.toUpperCase() === "NL") space()`,
				`if ((row.country ?? "").trim().toLowerCase() === "us") states()`,
				`const fold = options.locale.split("-")[1]?.toLowerCase() === "fr" ? french : american`,
			])
		).resolves.toEqual(["1 lowercase", "2 case-call", "3 case-call", "4 case-call"])
	})

	it("reports a locale tag and a street locale", async () => {
		await expect(
			reportedLines([
				`if (locale === "en-US") imperial()`,
				`if (options.locale !== "zh-Hant-TW") simplify()`,
				`if (this.#locale === "us" || streetLocale === "zh") fold()`,
				`if (locale.toLowerCase() === "en-us") imperial()`,
			])
		).resolves.toEqual(["1 locale-tag", "2 locale-tag", "3 street-locale", "3 street-locale", "4 locale-tag"])
	})

	it("reports each country case of a switch on a country or a locale", async () => {
		await expect(
			reportedLines([
				`switch (country.toUpperCase()) {`,
				`\tcase "GB":`,
				`\t\treturn 1`,
				`\tdefault:`,
				`\t\treturn 0`,
				`}`,
				`switch (locale) {`,
				`\tcase "vn":`,
				`\t\treturn 2`,
				`\tcase "und":`,
				`\t\treturn 3`,
				`}`,
			])
		).resolves.toEqual(["2 switch-case", "8 switch-case"])
	})

	it("reports a hard-coded default country, list or locale", async () => {
		await expect(
			reportedLines([
				`const DEFAULT_COUNTRIES = ["US"]`,
				`export const UPRN_COVERED_COUNTRIES: ReadonlySet<string> = new Set(["GB"])`,
				`const home = { country: cfg.country ?? "US" }`,
				`function build(country = "US", { countries = ["FR"] } = {}) {}`,
				`const tag = options.locale ?? "en-US"`,
				`const key = opts.streetLocale ?? "us"`,
				`export const DEFAULT_LOCALE = "en-us"`,
			])
		).resolves.toEqual([
			"1 default",
			"2 default",
			"3 default",
			"4 default",
			"4 default",
			"5 default",
			"6 default",
			"7 default",
		])
	})

	it("leaves a list of three codes to country-literal-sets", async () => {
		await expect(reportedLines([`const ANCHOR_COUNTRIES = ["DE", "FR", "US"]`])).resolves.toEqual([])
	})

	it("admits each form's nearest look-alike that holds no country", async () => {
		await expect(
			reportedLines([
				// A language, a subdivision and a unit are two letters and no country.
				`if (language === "en") english()`,
				`if (state === "NY" || region === "CA") provinces()`,
				`if (unit.toLowerCase() === "km") metric()`,
				`switch (language) {`,
				`\tcase "fr":`,
				`\t\treturn 1`,
				`}`,
				// The synthetic-row country is no place.
				`if (row.country === "ZZ") skip()`,
				// A tag whose region is no country, and a tag held by a name that states no locale.
				`if (locale === "en-XX") skip()`,
				`if (label === "to-DO") skip()`,
				// A default that's no code, and a country binding that holds no list of codes.
				`const fallback = country ?? ""`,
				`const DEFAULT_LANGUAGES = ["en"]`,
				// A site's interface language is a locale default that states no region.
				`const site = { defaultLocale: "en" }`,
				`const COUNTRY_NAMES = ["France"]`,
				`const tag = language ?? "en"`,
			])
		).resolves.toEqual([])
	})

	it("admits a marked branch, with the reason on the line, above the statement, or above a case or a member", async () => {
		await expect(
			reportedLines([
				`// country-branch: the US layout is the only one the synthesizer renders. The codex layouts cover the rest,`,
				`// and the reason may run to a second comment line above a statement that wraps.`,
				`const skip =`,
				`\ttuple.country !== "US"`,
				`const slug = country === "fr" ? "fr" : "us" // country-branch: two street databases exist.`,
				`switch (cc) {`,
				`\t// country-branch: the outward code is a GB postcode's routing part.`,
				`\tcase "GB":`,
				`\t\treturn 1`,
				`}`,
				`class Lookup {`,
				`\t// country-branch: the first street database built was the US one.`,
				`\tcountries = ["US"]`,
				`\tother = country === "DE"`,
				`}`,
				`const session = {`,
				`\t// country-branch: the first weights shipped were en-US.`,
				`\tlocale: options.locale ?? "en-US",`,
				`}`,
				`// country-branch: each case is one street locale's fold.`,
				`switch (locale) {`,
				`\tcase "fr":`,
				`\t\treturn 1`,
				`\tcase "de":`,
				`\t\treturn 2`,
				`}`,
			])
		).resolves.toEqual(["14 comparison"])
	})

	it("admits every branch under a country directory, and none under two letters that are no country", async () => {
		await expect(
			reported({
				"packages/corpus/lib/fr/recipes/order.ts": `if (country === "FR") render()\n`,
				"packages/osm/lib/vn.ts": `if (country === "VN") render()\n`,
				"packages/codex/lib/postcode.ts": `if (country === "GB") render()\n`,
				"packages/core/lib/fs/readers.ts": `if (country === "US") render()\n`,
				"lib/repo-health/ci/annotations.ts": `if (country === "CI") render()\n`,
				"packages/corpus/lib/recipes/order.test.ts": `if (country === "US") render()\n`,
				"packages/corpus/lib/recipes/table.generated.ts": `if (country === "US") render()\n`,
			})
		).resolves.toEqual([
			"lib/repo-health/ci/annotations.ts:1 comparison",
			"packages/core/lib/fs/readers.ts:1 comparison",
		])
	})
})
