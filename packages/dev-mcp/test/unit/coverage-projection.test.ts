/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `projectCoverage` — the projection that dropped the guard it was supposed to carry.
 *
 *   The corpus-mismatch guard was computed correctly by the census, covered by fifteen passing tests, and INVISIBLE on
 *   its first live call: this projection builds its result field by field and did not name it. That is the same shape
 *   as every other silent-absence defect in this repo — a field the consumer needed came back missing rather than
 *   wrong, and missing reads as "there is none of it". So the projection is pure and tested, not inline and trusted.
 */

import { projectCoverage } from "@mailwoman/dev-mcp/tools/coverage"
import type { CoverageReport } from "mailwoman/coverage-census"
import { describe, expect, it } from "vitest"

function report(overrides: Partial<CoverageReport> = {}): CoverageReport {
	return {
		countries: [
			{
				country: "IN",
				corpusRows: 0,
				corpusStreetRows: 0,
				admitted: true,
				gazetteerPlaces: 1_545_916,
				geocodeTier: "locality",
				boardRows: 3,
				boardGatedRows: 1,
			},
		],
		mismatches: {
			presentButDropped: [],
			admittedButEmpty: ["IN"],
			packageWithoutTraining: [],
			trainedButUnmeasured: [],
			measuredButUntrained: [],
		},
		corpusVersion: "0.26.0-trailing-region-leftcontext",
		corpusRowsTotal: 681_392_562,
		corpusCensusTakenAt: "2026-08-23T10:59:47.356Z",
		configPath: "/configs/v5.0.0.yaml",
		gazetteerPath: "/wof/candidate.db",
		notes: [],
		...overrides,
	}
}

describe("projectCoverage", () => {
	it("CARRIES the corpus mismatch — the field this projection silently dropped", () => {
		const out = projectCoverage(
			report({
				configuredCorpusVersion: "0.27.0-house-venue-intl",
				corpusMismatch: "The census counted 0.26.0; the config trains on 0.27.0.",
			})
		)

		expect(out["corpus_mismatch"]).toContain("0.27.0")
		expect(out["configured_corpus_version"]).toBe("0.27.0-house-venue-intl")
	})

	it("puts the mismatch FIRST in the summary, ahead of every count it invalidates", () => {
		// A caller reads the first sentence. Burying this after "33 countries train" means the counts are read as
		// answers before the reader learns they are about a corpus the run never opens.
		const out = projectCoverage(
			report({
				configuredCorpusVersion: "0.27.0-house-venue-intl",
				corpusMismatch: "The census counted 0.26.0; the config trains on 0.27.0.",
			})
		)

		expect(String(out["summary"]).startsWith("CORPUS MISMATCH")).toBe(true)
	})

	it("omits the mismatch entirely when the corpora agree", () => {
		const out = projectCoverage(report())

		expect(out).not.toHaveProperty("corpus_mismatch")
		expect(String(out["summary"]).startsWith("CORPUS MISMATCH")).toBe(false)
	})

	it("reports a requested country that exists nowhere, rather than returning an empty row set", () => {
		// An empty `rows` for a country nobody has heard of is indistinguishable from a country with no data. Naming it
		// separately is the difference between "absent" and "I could not find it".
		const out = projectCoverage(report(), ["ZZ"])

		expect(out["requested_but_absent_everywhere"]).toEqual(["ZZ"])
	})
})
