/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `projectCoverage` — the projection that dropped the guard it was supposed to preserve.
 *
 *   The census computed the corpus-mismatch guard correctly. Fifteen tests passed.
 *   The first live call still omitted the guard because this projection builds its result field by field.
 *   A consumer then reads a missing field as an absence. This test keeps the projection pure and checks that it includes the guard.
 */

import type { CoverageReport } from "mailwoman/coverage"
import { describe, expect, it } from "vitest"

import { projectCoverage } from "#tools/coverage"

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
				boardPassedRows: 1,
			},
		],
		countryLess: [],
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
		// A caller reads the first sentence.
		// If this follows "33 countries train", readers can mistake the counts for answers
		// before the reader learns they are about a corpus the run never opens.
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
		// An empty `rows` value for an unknown country is indistinguishable from a country with no data.
		// A separate label distinguishes "absent" from "I could not find it".
		const out = projectCoverage(report(), ["ZZ"])

		expect(out["requested_but_absent_everywhere"]).toEqual(["ZZ"])
	})
})
