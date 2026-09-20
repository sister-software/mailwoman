/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The funnel's denominator is the register's, and each stage's four states are told apart.
 *
 *   The case that matters most is the jurisdiction the census report never mentions. `censusCoverage` keys its rows on
 *   the union of five registers, so such a jurisdiction has no row there at all, and a funnel that inherited that
 *   denominator would print nothing for it — which is the reading this module exists to prevent.
 */

import {
	type AddressSourceRecord,
	type AddressSourceRegister,
	BackboneState,
	type JurisdictionRecord,
	JurisdictionResearchState,
	LicenseReviewState,
	ResearchPass,
	SourceGeometry,
	SourceStatus,
} from "@mailwoman/corpus/source-register"
import { AssertedProposition } from "@mailwoman/evidence/status"
import type { CountryCoverage } from "mailwoman/coverage"
import {
	FUNNEL_STAGES,
	incumbencyGroups,
	opportunityCandidates,
	readCoverageFunnel,
	StageState,
} from "mailwoman/eval-harness/coverage-funnel"
import { describe, expect, it } from "vitest"

function jurisdiction(iso2: string, overrides: Partial<JurisdictionRecord> = {}): JurisdictionRecord {
	return {
		iso2,
		name: iso2,
		backboneState: BackboneState.Unverified,
		researchState: JurisdictionResearchState.Seeded,
		bestPath: "G0",
		assertionPlan: "IDENTITY + OBSERVATION",
		note: "",
		...overrides,
	}
}

function source(iso2: string, licenseID: string): AddressSourceRecord {
	return {
		sourceID: `${iso2.toLowerCase()}-health-1`,
		iso2,
		sector: "health",
		name: `${iso2} facility register`,
		status: SourceStatus.VerifiedAuthority,
		asserts: [AssertedProposition.Identity],
		authorityBasis: "national",
		geometry: SourceGeometry.Unresolved,
		license: licenseID,
		researchPass: ResearchPass.WebResearch,
		access: "portal",
		publisher: `${iso2} ministry`,
		sourceURL: "https://example.invalid",
		note: "",
	}
}

/**
 * Four jurisdictions, one per shape the funnel has to tell apart: a deep incumbent, a researched jurisdiction whose
 * terms nobody opened, a researched absence, and one the census never mentions.
 */
function testRegister(): AddressSourceRegister {
	return {
		registerID: "test",
		version: "0.0.0-test",
		provenance: { source: "test", sourceVersion: "test", authoredAt: "2026-09-20", notes: "" },
		unresolved: [],
		licenses: [
			{
				licenseID: "elected-open",
				state: LicenseReviewState.Elected,
				electedTerms: "Licence Ouverte 2.0",
				retrievedCopy: "docs/licenses/lo-2.0.txt",
				electedBecause: "the attribution-only half of a dual grant",
			},
			{
				licenseID: "unchecked-national-terms",
				state: LicenseReviewState.Unchecked,
				publisherStatement: "Free",
				note: "an access label rather than a grant",
			},
		],
		jurisdictions: [
			jurisdiction("US"),
			jurisdiction("KE"),
			jurisdiction("AQ", { researchState: JurisdictionResearchState.Exception }),
			jurisdiction("IO", { researchState: JurisdictionResearchState.Unexamined }),
		],
		sources: [source("US", "elected-open"), source("KE", "unchecked-national-terms")],
	}
}

const US_COVERAGE: CountryCoverage = {
	country: "US",
	corpusRows: 400_000,
	corpusStreetRows: 380_000,
	admitted: true,
	weightsPackage: "@mailwoman/neural-weights-en-us",
	gazetteerPlaces: 200_000,
	geocodeTier: "rooftop-published",
	boardRows: 60,
	boardPassedRows: 40,
}

const KE_COVERAGE: CountryCoverage = {
	country: "KE",
	corpusRows: 0,
	corpusStreetRows: 0,
	admitted: true,
	gazetteerPlaces: 10,
	geocodeTier: "locality",
	boardRows: 3,
	boardPassedRows: 0,
}

async function funnel(overrides: Partial<Parameters<typeof readCoverageFunnel>[0]> = {}) {
	return await readCoverageFunnel({
		coverage: [US_COVERAGE, KE_COVERAGE],
		register: testRegister(),
		tieredCountries: ["US", "KE"],
		protectedCountries: ["US"],
		...overrides,
	})
}

describe("readCoverageFunnel", () => {
	it("keeps the register's denominator rather than the census report's", async () => {
		const report = await funnel()

		expect(report.rows).toHaveLength(4)
		expect(report.provenance.jurisdictions).toBe(4)
		expect(report.provenance.censusCountries).toBe(2)
		expect(report.rows.map((row) => row.iso2).toSorted()).toEqual(["AQ", "IO", "KE", "US"])
	})

	it("gives a jurisdiction the census never mentions a row reading absent rather than no row", async () => {
		const report = await funnel()
		const antarctica = report.rows.find((row) => row.iso2 === "AQ")

		expect(antarctica?.stages.corpusRows.state).toBe(StageState.Absent)
		expect(antarctica?.stages.evaluated.state).toBe(StageState.Absent)
		expect(antarctica?.stages.packaged.state).toBe(StageState.Absent)
		expect(antarctica?.reached).toBe(0)
	})

	it("separates a researched absence from an unexamined jurisdiction", async () => {
		const report = await funnel()

		expect(report.rows.find((row) => row.iso2 === "AQ")?.stages.researched.state).toBe(StageState.Blocked)
		expect(report.rows.find((row) => row.iso2 === "IO")?.stages.researched.state).toBe(StageState.Absent)
	})

	it("reads a source with no elected terms as blocked rather than absent", async () => {
		const report = await funnel()
		const kenya = report.rows.find((row) => row.iso2 === "KE")

		expect(kenya?.stages.licensed.state).toBe(StageState.Blocked)
		expect(kenya?.stages.licensed.detail).toContain("none with elected terms")

		expect(report.rows.find((row) => row.iso2 === "US")?.stages.licensed.state).toBe(StageState.Reached)
	})

	it("reads a board carrying only tracking rows as blocked rather than absent", async () => {
		const report = await funnel()
		const kenya = report.rows.find((row) => row.iso2 === "KE")

		expect(kenya?.stages.evaluated.state).toBe(StageState.Reached)
		expect(kenya?.stages.checking.state).toBe(StageState.Blocked)
		expect(kenya?.stages.checking.detail).toContain("none of which check")
	})

	it("reads sampling as unknown until a mixture audit supplies it", async () => {
		const report = await funnel()

		for (const row of report.rows) {
			expect(row.stages.sampled.state).toBe(StageState.Unknown)
			expect(row.stages.sampled.detail).toContain("audit_epoch_mixture")
		}
	})

	it("reads an admitted country the audit never drew as a measured zero, not an unknown", async () => {
		// An audit's `by_country` enumerates every country it drew, so KE — admitted, and absent from the audit — drew
		// zero of the 250,000 rows sampled. Measured on the audit's own denominator rather than unknown. This is the
		// shape the real v5.9.0 audit reports for 97 of 135 admitted countries.
		const report = await funnel({
			sampledRows: new Map([["US", 250_000]]),
			sampledTotal: 250_000,
		})

		const kenya = report.rows.find((row) => row.iso2 === "KE")

		expect(report.rows.find((row) => row.iso2 === "US")?.stages.sampled.state).toBe(StageState.Reached)
		expect(kenya?.stages.sampled.state).toBe(StageState.Blocked)
		expect(kenya?.stages.sampled.detail).toContain("250000")
	})

	it("reads a country the config never admitted as absent rather than blaming the sampler", async () => {
		// AQ carries no census row, so it is not admitted. It cannot draw, and reporting it as a sampling failure would
		// attribute the admission filter's decision to the sampler.
		const report = await funnel({
			sampledRows: new Map([["US", 250_000]]),
			sampledTotal: 250_000,
		})

		expect(report.rows.find((row) => row.iso2 === "AQ")?.stages.sampled.state).toBe(StageState.Absent)
	})

	it("counts every jurisdiction once per stage, across all four states", async () => {
		const report = await funnel()

		for (const stage of FUNNEL_STAGES) {
			const counts = report.byStage[stage]
			const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

			expect(total, `${stage} counts ${total} of ${report.rows.length}`).toBe(report.rows.length)
		}
	})

	it("surfaces a verified source with no corpus rows, and skips one that has rows", async () => {
		// US carries corpus rows, so it is not a candidate however far its research got. KE carries none, and the
		// fixture's jurisdictions default to backbone `C`, so widening the filter is what reaches it.
		const report = await funnel()

		expect(opportunityCandidates(report).map((entry) => entry.iso2)).toEqual([])
		expect(opportunityCandidates(report, ["C"]).map((entry) => entry.iso2)).toEqual(["AQ", "IO", "KE"])
	})

	it("reports whether a candidate is admitted, which separates a config defect from a corpus gap", async () => {
		const report = await funnel()
		const kenya = opportunityCandidates(report, ["C"]).find((entry) => entry.iso2 === "KE")

		// KE is admitted by the training config and carries no corpus row. That is the config promising a locale it
		// cannot deliver, which is different work from a country the config never named.
		expect(kenya?.admitted).toBe(true)
		expect(kenya?.licensed).toBe(false)
		expect(opportunityCandidates(report, ["C"]).find((entry) => entry.iso2 === "AQ")?.admitted).toBe(false)
	})

	it("orders by how far the source research got, not by existing coverage", async () => {
		const report = await funnel()
		const ordered = opportunityCandidates(report, ["C", "A"]).map((entry) => entry.backboneState)

		// Every state in the requested order comes before every state after it.
		expect(ordered).toEqual([...ordered].toSorted((left, right) => (left === right ? 0 : left === "C" ? -1 : 1)))
	})

	it("groups jurisdictions by stages reached, deepest first", async () => {
		const groups = incumbencyGroups(await funnel())

		expect(groups[0]?.reached).toBeGreaterThan(groups.at(-1)?.reached ?? 0)
		expect(groups.flatMap((group) => group.jurisdictions)).toHaveLength(4)
		expect(groups[0]?.jurisdictions).toEqual(["US"])
	})
})
