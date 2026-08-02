/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report-renderer tests. The renderer is pure — rows in, markdown out, `buildDate` injected — so
 *   the committed artifact's shape is asserted without touching a DB or a clock.
 */

import type { ComponentTag } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"

import { renderGranularityReport } from "./granularity-report.ts"
import type { CountryGranularity, RungMeasurement } from "./granularity.ts"
import { LADDER } from "./granularity.ts"

function row(
	country: string,
	spec: Partial<
		Record<
			string,
			{ nodes?: number; overtureBackfilled?: number; geonamesBackfilled?: number; parentCoverage?: number }
		>
	>,
	localityParents = 100
): CountryGranularity {
	const rungs: Partial<Record<ComponentTag, RungMeasurement>> = {}

	for (const rung of LADDER) {
		const given = spec[rung]

		rungs[rung] = {
			nodes: given?.nodes ?? 0,
			overtureBackfilled: given?.overtureBackfilled ?? 0,
			geonamesBackfilled: given?.geonamesBackfilled ?? 0,
			parentsCovered: Math.round((given?.parentCoverage ?? 0) * localityParents),
			parentCoverage: given?.parentCoverage ?? 0,
		}
	}

	return { country, localityParents, rungs }
}

const META = {
	sourcePath: "$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db",
	sourceMD5: "d41d8cd98f00b204e9800998ecf8427e",
	buildDate: "2026-08-02T00:00:00.000Z",
	floor: 0.05,
}

describe("renderGranularityReport", () => {
	it("puts the bottoms-out-at column in the summary table", () => {
		const markdown = renderGranularityReport(
			[
				row("GB", {
					country: { nodes: 1 },
					locality: { nodes: 16_677 },
					dependent_locality: { nodes: 13_177, parentCoverage: 0.33 },
				}),
			],
			META
		)

		expect(markdown).toContain("| GB |")
		expect(markdown).toContain("dependent_locality")
	})

	it("marks a country whose rung is Overture-backfilled rather than real WOF", () => {
		const markdown = renderGranularityReport(
			[row("IE", { country: { nodes: 1 }, locality: { nodes: 3230, overtureBackfilled: 3230 } })],
			META
		)

		expect(markdown).toMatch(/IE[^\n]*100\.0% ovt/)
	})

	it("pins the source and the floor in the header", () => {
		const markdown = renderGranularityReport([row("GB", { country: { nodes: 1 } })], META)

		expect(markdown).toContain("d41d8cd98f00b204e9800998ecf8427e")
		expect(markdown).toContain("2026-08-02T00:00:00.000Z")
		expect(markdown).toContain("5.0%")
	})

	it("declares its own limits inline", () => {
		const markdown = renderGranularityReport([row("GB", { country: { nodes: 1 } })], META)

		expect(markdown).toContain("Counts are not quality")
		expect(markdown).toContain("meaning-of-zero")
	})

	it("classifies each country by the source observed in the artifact, not by the recipe", () => {
		const markdown = renderGranularityReport(
			[
				row("GB", { locality: { nodes: 16_677 } }),
				row("IE", { locality: { nodes: 3230, overtureBackfilled: 3230 } }),
				row("ZW", { locality: { nodes: 500, geonamesBackfilled: 500 } }),
			],
			META
		)

		expect(markdown).toMatch(/^\| GB \| wof-repo \|/m)
		expect(markdown).toMatch(/^\| IE \| overture \|/m)
		expect(markdown).toMatch(/^\| ZW \| geonames \|/m)
	})

	it("flags a recipe/artifact mismatch as rebuild pending rather than claiming wof-repo", () => {
		// IN is in DEFAULT_WOF_PRIORITY_COUNTRIES, but until the gazetteer is rebuilt its rows are still Overture.
		const markdown = renderGranularityReport(
			[row("IN", { locality: { nodes: 282_992, overtureBackfilled: 282_992 } })],
			META
		)

		expect(markdown).toMatch(/^\| IN \| overture \(rebuild pending\) \|/m)
	})

	it("labels GeoNames-sourced rows gn rather than ovt", () => {
		const markdown = renderGranularityReport([row("ZW", { locality: { nodes: 500, geonamesBackfilled: 500 } })], META)

		const line = markdown.split("\n").find((l) => l.startsWith("| ZW |"))

		expect(line).toContain("100.0% gn")
		expect(line).not.toContain("ovt")
	})

	it("warns that an empty rung in a non-WOF-repo country is not a finding about WOF", () => {
		const markdown = renderGranularityReport([row("IE", { country: { nodes: 1 } })], META)

		expect(markdown).toContain("It is a country we never asked.")
		expect(markdown).toContain("260")
	})

	it("renders a measured-and-empty rung as 0 rather than omitting it", () => {
		const markdown = renderGranularityReport([row("IE", { country: { nodes: 1 }, locality: { nodes: 3230 } })], META)

		// IE was measured for dependent_locality and has none: the cell must exist and read 0.
		const ieLine = markdown.split("\n").find((line) => line.startsWith("| IE |"))

		expect(ieLine).toBeDefined()
		expect(ieLine).toContain("| 0 |")
	})
})
