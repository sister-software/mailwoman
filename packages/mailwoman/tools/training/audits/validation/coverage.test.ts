/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readTrainingConfigText, typedTrainingConfig, weightedCountries } from "@mailwoman/corpus/training/config/load"
import { expect, test } from "vitest"

import { blindCountries, expandRequirements, failingRequirements, type SplitScan } from "./coverage.ts"

function scan(byCountry: Record<string, [number, number]>): SplitScan {
	return {
		files: 1,
		rows: 0,
		countries: Object.keys(byCountry).length,
		by_country: Object.fromEntries(
			Object.entries(byCountry).map(([cc, [rows, street]]) => [cc, { rows, street_rows: street }])
		),
		by_country_source: {},
	}
}

const floor = (country: string, minRows: number, minStreetRows = 0, split = "val") => ({
	country,
	split,
	min_rows: minRows,
	min_street_rows: minStreetRows,
})

test("an absent country and a streetless one are different findings", () => {
	const splits = { val: scan({ US: [10, 0] }), test: scan({ US: [10, 4] }) }

	expect(blindCountries(splits, ["US", "GB"])).toEqual({
		US: { val: "10 rows, none carrying a street or house number" },
		GB: { val: "no rows at all", test: "no rows at all" },
	})
})

test("a country the split holds nothing for fails on both counts", () => {
	expect(failingRequirements({ val: scan({}) }, [floor("GB", 5, 2)])[0]).toMatchObject({
		rows: 0,
		street_rows: 0,
		because: "0 rows against a floor of 5; 0 street rows against a floor of 2",
	})
})

test("a met floor reports no failure", () => {
	expect(failingRequirements({ val: scan({ GB: [5, 2] }) }, [floor("GB", 5, 2)])).toEqual([])
})

test("a floor naming a split the report lacks is a failure", () => {
	expect(failingRequirements({ val: scan({}) }, [floor("GB", 1, 0, "test")])).toEqual([
		{ country: "GB", split: "test", because: "the report carries no test split" },
	])
})

/**
 * The schema defaults with `data.country_weights` replaced, as a loaded YAML config holds them.
 */
const weighted = (countryWeights: Record<string, number>) => {
	const rows = Object.entries(countryWeights).map(([country, weight]) => `    "${country}": ${weight}`)

	return typedTrainingConfig(readTrainingConfigText(`data:\n  country_weights:\n${rows.join("\n")}\n`, "test"), "test")
}

test("an every-country entry expands over the admitted countries, keeping an explicit entry", () => {
	const admitted = weightedCountries(weighted({ US: 1, FR: 1, DE: 0 }))
	const expanded = expandRequirements([floor("*", 3), floor("FR", 9)], admitted)

	expect(expanded).toEqual([floor("FR", 9), floor("US", 3)])
})

test("expansion reads the branded admitted set rather than a weight map or a literal list", () => {
	// The compiler checks these calls, and the test never runs them.
	const refused = () => {
		// @ts-expect-error The weight map is not the admitted set: weight-zero keys would expand.
		expandRequirements([floor("*", 3)], { US: 1, DE: 0 })

		// @ts-expect-error A literal list carries no brand.
		expandRequirements([floor("*", 3)], ["US", "DE"])
	}

	expect(refused).toBeTypeOf("function")
	expect(() => weightedCountries(weighted({ US: 1, QQ: 1 }))).toThrow(/QQ/)
})
