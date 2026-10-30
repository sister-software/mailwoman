/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { orderedJSON } from "@mailwoman/core/json"
import { mtfNode, type SampledRow } from "@mailwoman/mtf/tools/sampler/native"
import { describe, expect, test } from "vitest"

import { auditMixedScriptRows, goldComponents } from "./mixed-script.ts"

const { pythonText } = await mtfNode()

// The rows `audits.mixed_script.audit_rows` was run on before the port, with its answers below.
const ROWS: SampledRow[] = [
	{
		raw: "Four Seasons Inn四季酒家, 𦑃町",
		tokens: [],
		labels: [],
		country: "JP",
		source: "osm",
		spanStarts: [0, 22],
		spanEnds: [20, 25],
		spanTags: ["venue", "locality"],
	},
	{
		raw: "Rinrin, 高山市",
		tokens: ["Rinrin,", "高山市"],
		labels: ["B-venue", "B-locality"],
		country: "JP",
		source: "legacy",
	},
	{
		raw: "Calle 5º, Madrid",
		tokens: [],
		labels: [],
		country: "ES",
		source: "oa",
		spanStarts: [0, 10],
		spanEnds: [8, 16],
		spanTags: ["street", "locality"],
	},
]

describe("mixed-script audit", () => {
	test("gives the answers the Python audit gave on the same rows", () => {
		const report = auditMixedScriptRows(pythonText, ROWS, 1)
		const text = (key: string) => orderedJSON(report.get(key))

		expect(text("totals")).toBe(
			'{"components":6,"legacy_bio_rows":1,"mixed_components":1,"rows":3,"rows_cross_component_only":1,' +
				'"rows_with_mixed_component":1,"rows_with_multiple_scripts":2,"script_transitions":1,' +
				'"scripted_components":6,"span_truth_rows":2,"mixed_rate":0.16666666666666666}'
		)

		expect(orderedJSON((report.get("by_tag") as Map<string, unknown>).get("venue"))).toBe(
			'{"components":2,"mixed_components":1,"script:Han":1,"script:Latin":2,"script_transitions":1,' +
				'"scripted_components":2,"transition:Latin->Han":1,"mixed_rate":0.5}'
		)

		expect(text("by_country")).toBe(
			'{"ES":{"scripted_components":2,"mixed_rate":0},' +
				'"JP":{"mixed_components":1,"scripted_components":4,"mixed_rate":0.25}}'
		)

		expect(orderedJSON(report.get("examples"))).toBe(
			'{"venue":[{"raw":"Four Seasons Inn四季酒家, 𦑃町","surface":"Four Seasons Inn四季酒家",' +
				'"scripts":["Latin","Han"],"country":"JP","source":"osm"}]}'
		)
	})

	test("span offsets are UTF-16 code units, and one inside a surrogate pair is refused", () => {
		expect([...goldComponents(ROWS[0]!)]).toEqual([
			["venue", "Four Seasons Inn四季酒家"],
			["locality", "𦑃町"],
		])

		expect(() => [
			...goldComponents({ ...ROWS[0]!, spanStarts: [23], spanEnds: [25], spanTags: ["locality"] }),
		]).toThrow("not UTF-16 boundaries")
	})
})
