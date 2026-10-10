/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { findCountryBranches, isCountryHome } from "#repo-health/checks/country-branches"

const shared = (text: string) => [{ file: "packages/corpus/lib/recipes/thing.ts", text }]

describe("isCountryHome", () => {
	it("admits a country directory, a country file name and the codex", () => {
		expect(isCountryHome("packages/corpus/lib/us/adapters/tiger/adapter.ts")).toBe(true)
		expect(isCountryHome("packages/mailwoman/tools/gazetteer-pipeline/postcode/locality/jp.ts")).toBe(true)
		expect(isCountryHome("packages/codex/lib/country.ts")).toBe(true)
	})

	it("refuses a shared module", () => {
		expect(isCountryHome("packages/corpus/lib/recipes/venue.ts")).toBe(false)
		expect(isCountryHome("packages/corpus/lib/synthesizers/utils.ts")).toBe(false)
	})
})

describe("findCountryBranches", () => {
	it("reports an equality against a country literal on a country operand", () => {
		const found = findCountryBranches(shared(`if (tuple.country === "US") return null\n`))

		expect(found).toEqual([{ file: "packages/corpus/lib/recipes/thing.ts", line: 1, text: `tuple.country === "US"` }])
	})

	it("reports a case clause of a switch on a country", () => {
		const found = findCountryBranches(
			shared(`switch (cc) {\n\tcase "GB":\n\t\treturn 1\n\tdefault:\n\t\treturn 0\n}\n`)
		)

		expect(found.map((f) => f.line)).toEqual([2])
	})

	it("admits a marked branch, the synthetic country and a non-country operand", () => {
		const text = [
			`// country-branch: the US layout is the only one the synthesizer renders. The codex layouts cover the rest,`,
			`// and the reason may run to a second comment line above a statement that wraps.`,
			`const skip =`,
			`\ttuple.country !== "US"`,
			`if (skip) return null`,
			`if (row.country === "ZZ") skip()`,
			`if (region === "CA") provinces()`,
			``,
		].join("\n")

		expect(findCountryBranches(shared(text))).toEqual([])
	})

	it("admits every branch in a module under a country directory", () => {
		const found = findCountryBranches([
			{ file: "packages/corpus/lib/fr/recipes/order.ts", text: `if (country === "FR") render()\n` },
		])

		expect(found).toEqual([])
	})
})
