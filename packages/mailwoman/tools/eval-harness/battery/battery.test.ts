import { describe, expect, it } from "vitest"

import { formatBatteryReport, scoreBatteryRow } from "#tools/eval-harness/battery/battery"
import type { BatterySpan } from "#tools/eval-harness/battery/classify"
import { BATTERY_SUITES, type BatterySuiteRow } from "#tools/eval-harness/battery/suites"

const districtSuite = BATTERY_SUITES.find((s) => s.id === "osm-district-before-city")!

const row: BatterySuiteRow = {
	source_id: "osm-md-1",
	raw: "Strada Tricolorului, 35, Raionul Fălești, MD-5938 Obreja Veche",
	country: "MD",
	span_starts: [0, 21, 25, 42, 50],
	span_ends: [19, 23, 40, 49, 62],
	span_tags: ["street", "house_number", "subregion", "postcode", "locality"],
}

const right: BatterySpan[] = [
	["street", 0, 19, "Strada Tricolorului"],
	["house_number", 21, 23, "35"],
	["subregion", 25, 40, "Raionul Fălești"],
	["postcode", 45, 49, "5938"],
	["locality", 50, 62, "Obreja Veche"],
]

const wrong: BatterySpan[] = [
	["street", 0, 19, "Strada Tricolorului"],
	["postcode", 21, 23, "35"],
	["subregion", 25, 40, "Raionul Fălești"],
	["postcode", 45, 49, "5938"],
	["locality", 50, 62, "Obreja Veche"],
]

describe("scoreBatteryRow", () => {
	const scored = scoreBatteryRow(districtSuite, row, ["a", "b"], (arm) => (arm === "a" ? right : wrong))

	it("scores a postcode read without its country prefix right after the correction", () => {
		expect(scored.rightUncorrected.a).toBe(false)
		expect(scored.right.a).toBe(true)
		expect(scored.corrections.a).toEqual(["postcode-country-prefix"])
	})

	it("files a wrong row under its cause", () => {
		expect(scored.right.b).toBe(false)
		expect(scored.cause.b).toBe("number-boundary")
	})

	it("refuses a row an arm has no parse for", () => {
		expect(() => scoreBatteryRow(districtSuite, row, ["a"], () => undefined)).toThrow(/a has no parse for osm-md-1/)
	})

	it("renders the report with its failure groups", () => {
		const markdown = formatBatteryReport(
			{
				arms: [
					{ name: "a", cache: "/a" },
					{ name: "b", cache: "/b" },
				],
				baseline: "a",
				seeds: [],
				suites: { [districtSuite.id]: { rows: [scored] } },
			},
			"2026-10-29T00:00:00.000Z"
		)

		expect(markdown).toContain("| osm-district-before-city | 1 | 100.0% | 0.0% | 0 |")
		expect(markdown).toContain("## Failure groups, decision rows only")
		expect(markdown).toContain("#### osm-district-before-city / number-boundary (1 rows)")
	})
})
