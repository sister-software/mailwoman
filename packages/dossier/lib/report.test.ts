/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier } from "#dossier"
import { StatementKind } from "#explanations"
import { renderReport } from "#report"
import { EXAMPLE_RECORDS, HOUSE } from "#test/fixtures/example-house"
import { OPP_RECORDS } from "#test/fixtures/one-park-point"
import type { DossierRecords } from "#validate"

/**
 * The lines of one building's serviceability section, from its heading to the next building.
 */
function serviceabilityLines(report: string, building: string): string[] {
	const section = report.split(`## ${building}\n`)[1]!.split("\n## ")[0]!

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one rendered report section, already in memory and under 100 lines
	return section.split("### Serviceability checks\n")[1]!.split("\n")
}

/**
 * The non-empty lines of one building's claims part, from its heading to the next part.
 */
function claimLines(report: string, building: string): string[] {
	const section = report.split(`## ${building}\n`)[1]!.split("\n## ")[0]!

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one rendered report section, already in memory and under 100 lines
	return section
		.split("### Claims\n")[1]!
		.split("\n### ")[0]!
		.split("\n")
		.filter((line) => line !== "")
}

describe("renderReport", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))

	test("states the cutoff and the admitted, excluded and undated records", () => {
		expect(report).toContain("as of 2022-06-30")
		expect(report).toContain("manager-2023")
		expect(report).toMatch(/undated.*undated-listing/i)
	})

	test("shows each building's counts by stage, with unresolved totals worded as unresolved", () => {
		expect(report).toMatch(/Example House/)
		expect(report).toMatch(/completed.*20/)
		expect(report).toMatch(/occupied.*unresolved/)
	})

	test("words a source-present empty reading as unknown absence", () => {
		expect(report).toMatch(/looked and found no record; absence is unknown/)
	})

	test("lists each unresolved question with the record that would resolve it", () => {
		expect(report).toMatch(/signing authority[\s\S]*would resolve/)
	})
})

describe("renderReport: the serviceability section", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))
	const lines = serviceabilityLines(report, "Example House")

	test("heads each check with its layer and the extent at which the source keys its lookup", () => {
		expect(lines).toContain("#### Check house-cable: cable keyed at cell-1")
	})

	test("prints the kind of every statement at the start of its line", () => {
		const kindLabel = new RegExp(`^\\s*- (${Object.values(StatementKind).join("|")})( \\([^)]*\\))?: `)
		const structureLabel = /^\s*- (explanation|supporting|conflicting|missing|investigate|if it holds|if it fails):/
		const items = lines.filter((line) => /^\s*- /.test(line))

		expect(items.filter((line) => !kindLabel.test(line) && !structureLabel.test(line))).toEqual([])

		const kinds = new Set(items.flatMap((line) => kindLabel.exec(line)?.[1] ?? []))

		expect([...kinds].toSorted()).toEqual(["decision", "deduction", "fact", "hypothesis"])
	})

	test("shows scenarios rather than a ranking when no probability is documented", () => {
		expect(lines).toContain(
			"Ranking: none. The access, installation and route explanations have no documented probability, so each explanation states the next action if it holds and if it fails."
		)

		expect(lines.filter((line) => line.startsWith("  - if it holds: "))).toHaveLength(3)
		expect(lines.filter((line) => line.startsWith("  - if it fails: "))).toHaveLength(3)
	})

	test("prints a documented ranking and its estimates", () => {
		const ranked = renderReport(
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					probabilities: (["access", "installation", "route"] as const).map((kind, index) => ({
						check: "house-cable",
						kind,
						probability: [0.5, 0.2, 0.3][index]!,
						basis: "a synthetic study",
						evidence: { source: "operator-log-2022" },
					})),
				},
				{ asOf: "2022-06-30" }
			)
		)

		const rankedLines = serviceabilityLines(ranked, "Example House")

		expect(rankedLines).toContain("Ranking by documented probability: access (0.5), route (0.3), installation (0.2).")

		expect(rankedLines).toContain(
			"- estimate (operator-log-2022): The probability that the route explanation holds is 0.3 (a synthetic study)."
		)
	})

	test("prints the operator's decision and its outcome", () => {
		expect(lines).toContain(
			'- decision (operator-log-2022): On 2022-06-01 the operator decided to investigate access: "Ask Example Management Co whether the provider holds permission for the south entrance".'
		)
	})

	test("reports blocker accuracy and time saved with their denominators", () => {
		const outcomes = report.split("## Operator outcomes\n")[1]!

		expect(outcomes).toContain(
			"- estimate (operator-log-2022): The investigated explanation held in 1 of 1 dispositions with a recorded outcome."
		)

		expect(outcomes).toContain(
			"- estimate (operator-log-2022): Against the operator's baselines, the investigations saved 60 minutes over 1 outcome that records both times."
		)
	})

	test("a building without a check has no serviceability section", () => {
		expect(report.split("## Example Annex\n")[1]).not.toContain("### Serviceability checks")
	})
})

describe("renderReport: the claims part", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))

	test("prints each claim's identifier, axis, predicate, value, status, source record and evidence date", () => {
		expect(claimLines(report, "Example House")).toEqual([
			"- c1 — premises storeys: 13 (observed, permit-2021, 2021-05-10)",
			'- c2 — network nearest_cabinet_connects: "unknown" (inferred, survey-2022, 2022-03-15)',
			"  - derives from: c1",
			"  - explanation: A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
		])

		expect(claimLines(report, "Example Annex")).toEqual([])
	})

	test("places the claims part after the layer readings and before the unresolved questions", () => {
		const section = report.split("## Example House\n")[1]!.split("\n## ")[0]!

		expect(section.match(/^### .+$/gm)).toEqual([
			"### Units",
			"### Events",
			"### Access",
			"### Construction",
			"### Providers",
			"### Layer readings",
			"### Claims",
			"### Unresolved",
			"### Serviceability checks",
		])
	})

	test("dates a claim by its evidence's observation date, then its source record's, and otherwise prints undated", () => {
		// The listing became available on 2022-01-03 and was retrieved on 2026-10-04, and it states no observation date.
		const records: DossierRecords = {
			...EXAMPLE_RECORDS,
			sources: [
				...EXAMPLE_RECORDS.sources,
				{
					id: "listing-2022",
					publisher: "Example Listings",
					title: "Dated rental listing",
					availableAt: "2022-01-03",
					retrievedAt: "2026-10-04",
				},
			],
			claims: [
				{
					id: "c6",
					subject: HOUSE,
					axis: "demand",
					predicate: "listed_units",
					value: 3,
					status: "observed",
					evidence: { source: "listing-2022" },
				},
				{
					id: "c7",
					subject: HOUSE,
					axis: "premises",
					predicate: "storeys",
					value: 13,
					status: "observed",
					evidence: { source: "survey-2022", observedAt: "2022-03-16" },
				},
				{
					id: "c8",
					subject: HOUSE,
					axis: "premises",
					predicate: "storeys",
					value: 13,
					status: "observed",
					evidence: { source: "survey-2022" },
				},
			],
		}

		expect(claimLines(renderReport(buildDossier(records, { asOf: "2022-06-30" })), "Example House")).toEqual([
			"- c6 — demand listed_units: 3 (observed, listing-2022, undated)",
			"- c7 — premises storeys: 13 (observed, survey-2022, 2022-03-16)",
			"- c8 — premises storeys: 13 (observed, survey-2022, 2022-03-15)",
		])
	})

	test("prints a derived claim's parents without an explanation, and each member of an object value", () => {
		const records: DossierRecords = {
			...EXAMPLE_RECORDS,
			claims: [
				...EXAMPLE_RECORDS.claims,
				{
					id: "c9",
					subject: HOUSE,
					axis: "identity",
					predicate: "site_grid_reference",
					value: { easting: 533_018, northing: 165_662, system: "OSGB36", corners: [] },
					status: "derived",
					derivedFrom: ["c1", "c2"],
					evidence: { source: "permit-2021" },
				},
			],
		}

		expect(claimLines(renderReport(buildDossier(records, { asOf: "2022-06-30" })), "Example House").slice(4)).toEqual([
			'- c9 — identity site_grid_reference: { easting: 533018, northing: 165662, system: "OSGB36", corners: [] } (derived, permit-2021, 2021-05-10)',
			"  - derives from: c1, c2",
		])
	})
})

describe("renderReport: positions, extents and unplaced readings", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))
	const sectionText = (building: string) => report.split(`## ${building}\n`)[1]!.split("\n## ")[0]!

	test("prints a building's position with its source and synthetic label, and the extents that place it", () => {
		expect(sectionText("Example House")).toContain("Position: -30.00012, -20.00034 (survey-2022), synthetic")
		expect(sectionText("Example House")).toContain("Extents: cell-1 (survey-2022), district-1 (permit-2021)")
		expect(sectionText("Example Annex")).toContain("Extents: district-1 (permit-2021)")
	})

	test("prints an unresolved position with each position that differs", () => {
		expect(sectionText("Example Annex")).toContain(
			"Position: unresolved — 2 positions state 2 different locations (-30.00021, -20.00032 per permit-2021, synthetic. -30.00025, -20.00041 per survey-2022, synthetic)"
		)
	})

	test("lists an unplaced reading in its own section with the record that would place it", () => {
		const unplaced = sectionText("Unplaced layer readings")

		expect(unplaced).toContain("- cable over cell-3 as of 2022-03-15: records present (survey-2022)")
		expect(unplaced).toContain("  - would resolve: a record that places a building in cell-3")
		expect(sectionText("Example House")).not.toContain("cell-3")
		expect(sectionText("Example Annex")).not.toContain("cell-3")
	})

	test("states that every admitted reading attaches to a building when none is unplaced", () => {
		const oppReport = renderReport(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" }))

		expect(oppReport.split("## Unplaced layer readings\n")[1]).toContain(
			"Every admitted reading attaches to a building."
		)

		expect(oppReport).toContain("Position: 40.65017, -73.97264 (pad-geosearch-26c)\n")
	})
})

describe("renderReport: one park point as of 2023-06-30", () => {
	const lines = serviceabilityLines(renderReport(buildDossier(OPP_RECORDS, { asOf: "2023-06-30" })), "11 Ocean Parkway")

	test("states the open exception and the two competing hypotheses", () => {
		expect(lines).toContain("Exception at the 2022-06-30 readings, open.")

		expect(lines).toContain(
			"  - hypothesis: 11 Ocean Parkway may not have been ready to receive service on 2022-06-30."
		)

		expect(lines).toContain(
			"  - hypothesis: The fcc-bdc-fttp network may not have reached census-block:360470504012000 on 2022-06-30."
		)

		expect(lines).toContain("Checked without a supporting record: identity, access and capacity.")
	})

	test("cites each supporting and conflicting record", () => {
		expect(lines).toContain(
			"    - fact (fcc-bdc-fttp-j22): The fcc-bdc-fttp reading over census-tract:36047050401 as of 2022-06-30 holds 70 records."
		)

		expect(lines).toContain(
			"    - fact (fcc-bdc-cable-j22): Charter Communications (Spectrum) cable 1000/35 Mbps (census block, business) is recorded as available at 11 Ocean Parkway on 2022-06-30."
		)
	})
})

describe("renderReport: one park point as of 2026-10-05", () => {
	const lines = serviceabilityLines(renderReport(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" })), "11 Ocean Parkway")

	test("states the resolved exception with the readings it failed on and the record that resolved it", () => {
		expect(lines).toContain("Exception at the 2022-06-30 readings, resolved.")

		expect(lines).toContain(
			"- fact (fcc-bdc-fttp-j22): The fcc-bdc-fttp reading over census-block:360470504012000 as of 2022-06-30 holds 0 records on a source_present basis."
		)

		expect(lines).toContain(
			"- deduction (fcc-bdc-fttp-d25): The fcc-bdc-fttp readings over census-block:360470504012000 from 2025-12-31 hold records, so the check passes from 2025-12-31 and resolves the exception recorded on 2022-06-30. A reading dated 2025-12-31 does not establish whether any explanation held on 2022-06-30."
		)
	})

	test("keeps the hypotheses and their investigations and prints no next action", () => {
		expect(lines).toContain(
			"  - hypothesis: 11 Ocean Parkway may not have been ready to receive service on 2022-06-30."
		)

		expect(lines).toContainEqual(expect.stringMatching(/^ {2}- investigate: /))
		expect(lines.filter((line) => /^ {2}- if it (holds|fails): /.test(line))).toEqual([])
		expect(lines).toContain("Ranking: none. The exception is resolved, so no next action depends on its explanations.")
	})
})
