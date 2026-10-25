import { describe, expect, it } from "vitest"

import { type PostcodeOrderGoldenRow, scoreNonNativeOrderRows } from "#tools/eval-harness/heldout/postcode-order"

const rows: PostcodeOrderGoldenRow[] = [
	{
		raw: "75001 Paris, 1 Rue de Rivoli",
		components: { house_number: "1", street: "Rue de Rivoli", locality: "Paris", postcode: "75001" },
		country: "FR",
	},
	{
		raw: "00100 Roma, Via Roma 2",
		components: { house_number: "2", street: "Via Roma", locality: "Roma", postcode: "00100" },
		country: "it",
	},
	{
		raw: "Calle 3 4, Ciudad",
		components: { house_number: "4", street: "Calle 3", locality: "Ciudad" },
		country: "MX",
	},
]

describe("scoreNonNativeOrderRows", () => {
	it("scores each span over the rows that hold it and the full match over every row", () => {
		const report = scoreNonNativeOrderRows(rows, [
			{ house_number: "1", street: " rue de rivoli ", locality: "PARIS", postcode: "75001" },
			{ house_number: "2", street: "Via Roma", locality: "Roma", postcode: "00100", region: "Roma" },
			{ house_number: "4", street: "Calle 3", postcode: "Ciudad" },
		])

		expect(report.overall.rows).toBe(rows.length)
		expect(report.overall.postcode).toEqual({ matched: 2, of: 2, rate: 1 })
		expect(report.overall.locality).toEqual({ matched: 2, of: 3, rate: 2 / 3 })
		expect(report.overall.full).toEqual({ matched: 1, of: 3, rate: 1 / 3 })

		expect(Object.keys(report.byCountry)).toEqual(["FR", "IT", "MX"])
		expect(report.byCountry.IT!.full.matched).toBe(0)
		expect(report.byCountry.MX!.postcode.of).toBe(0)
	})

	it("refuses predictions that do not line up with the rows", () => {
		expect(() => scoreNonNativeOrderRows(rows, [])).toThrow(/golden rows but 0 predictions/)
	})
})
