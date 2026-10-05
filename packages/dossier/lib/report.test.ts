/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier, type Dossier } from "#dossier"
import { StatementKind } from "#explanations"
import { renderReport, type ReportLine, ReportLineKind, reportLines, ReportPart } from "#report"
import {
	ACCESS_DISPOSITION,
	AVAILABILITY,
	EMPTY_RECORDS,
	EXAMPLE_RECORDS,
	HOUSE,
	RELATIONS,
} from "#test/fixtures/example-house"
import { OPP_RECORDS } from "#test/fixtures/one-park-point"
import { type DossierRecords, validateRecords } from "#validate"

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

		expect(rankedLines).toContain(
			"Ranking by documented probability: access (0.5), route (0.3), installation (0.2) (operator-log-2022)."
		)

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

/**
 * The texts of a report's conclusions that cite no source record the dossier admitted.
 */
function uncitedConclusions(dossier: Dossier): string[] {
	const admitted = new Set(dossier.admitted)

	return reportLines(dossier)
		.filter((line) => line.kind === ReportLineKind.Conclusion && !line.sources.some((source) => admitted.has(source)))
		.map((line) => line.text)
}

/**
 * The texts of a report's conclusions that cite a record the dossier did not admit,
 * or whose text omits a record the line cites.
 */
function misattributedConclusions(dossier: Dossier): string[] {
	const admitted = new Set(dossier.admitted)

	return reportLines(dossier)
		.filter(
			(line) =>
				line.kind === ReportLineKind.Conclusion &&
				!line.sources.every((source) => admitted.has(source) && line.text.includes(source))
		)
		.map((line) => line.text)
}

/**
 * The line records of one building's section.
 */
function sectionRecords(dossier: Dossier, building: string): ReportLine[] {
	return reportLines(dossier).filter((line) => line.building === building)
}

/**
 * The one line of `lines` whose text starts with `prefix`.
 */
function lineStarting(lines: readonly ReportLine[], prefix: string): ReportLine {
	const matches = lines.filter((line) => line.text.startsWith(prefix))

	expect(matches.map((line) => line.text)).toHaveLength(1)

	return matches[0]!
}

describe("reportLines: the line records renderReport prints", () => {
	test("renderReport prints the text of every line record, in order, and nothing else", () => {
		for (const [records, asOf] of [
			[EXAMPLE_RECORDS, "2022-06-30"],
			[OPP_RECORDS, "2022-06-30"],
			[OPP_RECORDS, "2023-06-30"],
			[OPP_RECORDS, "2026-10-05"],
		] as const) {
			const dossier = buildDossier(records, { asOf })

			expect(renderReport(dossier)).toBe(
				reportLines(dossier)
					.map((line) => line.text)
					.join("\n")
			)
		}
	})

	test("every line has one of the report's parts and kinds, and a section's lines name their building", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })
		const lines = reportLines(dossier)

		for (const line of lines) {
			expect(Object.values(ReportPart)).toContain(line.part)
			expect(Object.values(ReportLineKind)).toContain(line.kind)
		}

		expect(new Set(lines.flatMap((line) => line.building ?? []))).toEqual(new Set([HOUSE, "building:example-annex"]))

		expect(
			lines.filter((line) => line.text === "## Example House").map((line) => [line.part, line.kind, line.building])
		).toEqual([[ReportPart.Building, ReportLineKind.Heading, HOUSE]])
	})
})

describe("reportLines: every conclusion cites a source record the dossier admitted", () => {
	test("Example House as of 2022-06-30: the two building identifiers state no evidence and print source unstated", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		expect(reportLines(dossier).filter((line) => line.kind === ReportLineKind.Conclusion).length).toBeGreaterThan(0)
		expect(misattributedConclusions(dossier)).toEqual([])

		// The fixture states no source for its identifiers.
		// Each one stays a conclusion without a source, and validation reports it.
		expect(uncitedConclusions(dossier)).toEqual([
			"Identifiers: example:bin 1001 (source unstated)",
			"Identifiers: example:bin 1002 (source unstated)",
		])

		expect(
			validateRecords(EXAMPLE_RECORDS)
				.filter((issue) => issue.code === "identifier_without_evidence")
				.map((issue) => [issue.severity, issue.ref])
		).toEqual([
			["warning", "parcel:example-parcel identifier 0"],
			["warning", "building:example-house identifier 0"],
			["warning", "building:example-annex identifier 0"],
		])
	})

	test.each(["2022-06-30", "2023-06-30", "2026-10-05"])("One Park Point as of %s", (asOf) => {
		const dossier = buildDossier(OPP_RECORDS, { asOf })

		expect(reportLines(dossier).filter((line) => line.kind === ReportLineKind.Conclusion).length).toBeGreaterThan(0)
		expect(uncitedConclusions(dossier)).toEqual([])
		expect(misattributedConclusions(dossier)).toEqual([])
		expect(renderReport(dossier)).not.toContain("source unstated")
	})
})

describe("reportLines: the citation that each line without one gains", () => {
	const house = sectionRecords(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), HOUSE)
	const annex = sectionRecords(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), "building:example-annex")

	test("an identifier cites its admitted evidence, and one without evidence prints source unstated", () => {
		const opp = buildDossier(OPP_RECORDS, { asOf: "2026-10-05" })

		expect(lineStarting(reportLines(opp), "Identifiers:")).toMatchObject({
			text: "Identifiers: nyc:bin 3429422 (pad-geosearch-26c)",
			kind: ReportLineKind.Conclusion,
			sources: ["pad-geosearch-26c"],
		})

		expect(lineStarting(house, "Identifiers:")).toMatchObject({
			text: "Identifiers: example:bin 1001 (source unstated)",
			kind: ReportLineKind.Conclusion,
			sources: [],
		})
	})

	test("an identifier whose evidence the dossier excludes is left out, as an alias is", () => {
		const opp = reportLines(buildDossier(OPP_RECORDS, { asOf: "2023-06-30" }))

		expect(lineStarting(opp, "Identifiers:")).toMatchObject({
			text: "Identifiers: application id only",
			kind: ReportLineKind.Absence,
			sources: [],
		})

		expect(lineStarting(opp, "Entrances:").text).toBe("Entrances: 0. Aliases: none")
	})

	test("the entrance count and each alias cite their links", () => {
		expect(lineStarting(house, "Entrances:")).toMatchObject({
			text: 'Entrances: 2 (survey-2022). Aliases: "North entrance, Example House" (resolved) (survey-2022), "South entrance, Example House" (resolved) (survey-2022)',
			kind: ReportLineKind.Conclusion,
			sources: ["survey-2022"],
		})

		expect(lineStarting(annex, "Entrances:")).toMatchObject({
			text: "Entrances: 0. Aliases: none",
			kind: ReportLineKind.Absence,
			sources: [],
		})

		expect(lineStarting(reportLines(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" })), "Entrances:")).toMatchObject({
			text: 'Entrances: 0. Aliases: "11 Ocean Parkway, Brooklyn, NY 11218" (resolved) (pad-geosearch-26c)',
			kind: ReportLineKind.Conclusion,
		})
	})

	test("an event cites its record after its parties and scope", () => {
		expect(house.filter((line) => line.part === ReportPart.Events && line.kind === ReportLineKind.Conclusion)).toEqual([
			{
				text: "- landlord_permission on 2022-05-10 (Example Management Co. Scope entrance:example-house-north) (survey-2022)",
				part: ReportPart.Events,
				kind: ReportLineKind.Conclusion,
				building: HOUSE,
				sources: ["survey-2022"],
			},
		])
	})

	test("each permission cites its record, and no permission is an absence", () => {
		expect(lineStarting(house, "Permissions:")).toMatchObject({
			text: "Permissions: Example Management Co for entrance:example-house-north (survey-2022)",
			kind: ReportLineKind.Conclusion,
			sources: ["survey-2022"],
		})

		expect(lineStarting(annex, "Permissions:")).toMatchObject({
			text: "Permissions: none on record",
			kind: ReportLineKind.Absence,
		})
	})

	test("each role cites the record that names it", () => {
		expect(lineStarting(house, "Roles with unknown signing authority:")).toMatchObject({
			text: "Roles with unknown signing authority: Example Holdings LLC (owner) (permit-2021)",
			kind: ReportLineKind.Conclusion,
			sources: ["permit-2021"],
		})

		expect(lineStarting(house, "Roles with known signing authority:")).toMatchObject({
			text: "Roles with known signing authority: none",
			kind: ReportLineKind.Absence,
		})

		const signed = sectionRecords(
			buildDossier(
				{ ...EXAMPLE_RECORDS, relations: [{ ...RELATIONS[0]!, signingAuthority: "yes" }, RELATIONS[1]!] },
				{ asOf: "2022-06-30" }
			),
			HOUSE
		)

		expect(lineStarting(signed, "Roles with known signing authority:")).toMatchObject({
			text: "Roles with known signing authority: Example Holdings LLC (owner, yes) (permit-2021)",
			kind: ReportLineKind.Conclusion,
		})

		expect(lineStarting(signed, "Roles with unknown signing authority:")).toMatchObject({
			text: "Roles with unknown signing authority: none",
			kind: ReportLineKind.Absence,
		})
	})

	test("a provider line cites each availability record with its dates, and an unknown answer is an absence", () => {
		expect(lineStarting(house, "- Example Fiber")).toMatchObject({
			text: "- Example Fiber 1 Gbps: available on 2022-06-30 (from 2022-03-01 to 2022-09-30 per survey-2022)",
			kind: ReportLineKind.Conclusion,
			sources: ["survey-2022"],
		})

		expect(
			lineStarting(sectionRecords(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-12-31" }), HOUSE), "- Example Fiber")
		).toMatchObject({
			text: "- Example Fiber 1 Gbps: withdrawn on 2022-12-31 (from 2022-03-01 to 2022-09-30 per survey-2022)",
			kind: ReportLineKind.Conclusion,
		})

		const announced = buildDossier(
			{ ...EXAMPLE_RECORDS, availability: [{ ...AVAILABILITY[0]!, from: "2022-08-01", to: undefined }] },
			{ asOf: "2022-06-30" }
		)

		expect(lineStarting(sectionRecords(announced, HOUSE), "- Example Fiber")).toMatchObject({
			text: "- Example Fiber 1 Gbps: unknown on 2022-06-30 (from 2022-08-01 per survey-2022)",
			kind: ReportLineKind.Absence,
			sources: ["survey-2022"],
		})

		const opp = sectionRecords(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" }), "building:nyc-bin-3429422")

		expect(opp.filter((line) => line.part === ReportPart.Providers && line.text.startsWith("- "))).toMatchObject([
			{
				text: "- Charter Communications (Spectrum) cable 1000/35 Mbps (census block, business): available on 2026-10-05 (from 2022-06-30 per fcc-bdc-cable-j22)",
				kind: ReportLineKind.Conclusion,
			},
			{
				text: "- Verizon fiber to the premises 2300/2300 Mbps (census block, residential): available on 2026-10-05 (from 2025-12-31 per fcc-bdc-fttp-d25)",
				kind: ReportLineKind.Conclusion,
			},
		])
	})

	test("a section's layer reading cites the records of its group, as an unplaced reading does", () => {
		expect(
			house.filter((line) => line.part === ReportPart.Readings && line.text.startsWith("- ")).map((line) => line.text)
		).toEqual([
			"- ducts over cell-1: no survey. Unknown (survey-2022)",
			"- cabinets over cell-1 as of 2022-03-15: surveyed, zero records. Absence is established for the surveyed extent (survey-2022)",
			"- poles over cell-1: the source looked and found no record; absence is unknown (survey-2022)",
			"- cable over cell-1 as of 2022-03-15: the source looked and found no record; absence is unknown (survey-2022)",
			"- cable over district-1 as of 2022-03-15: records present (survey-2022)",
		])

		expect(lineStarting(annex, "- cable over district-1")).toMatchObject({
			text: "- cable over district-1 as of 2022-03-15: records present (survey-2022)",
			kind: ReportLineKind.Conclusion,
			sources: ["survey-2022"],
		})
	})

	test("a ranking by documented probability cites the records of its probabilities", () => {
		const dossier = buildDossier(
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

		expect(lineStarting(sectionRecords(dossier, HOUSE), "Ranking")).toMatchObject({
			text: "Ranking by documented probability: access (0.5), route (0.3), installation (0.2) (operator-log-2022).",
			kind: ReportLineKind.Conclusion,
			sources: ["operator-log-2022"],
		})
	})

	test("the count of dispositions that await an outcome cites their records", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				dispositions: [
					ACCESS_DISPOSITION,
					{
						id: "d2",
						check: "house-cable",
						investigated: "route",
						decision: "Request the provider's plant record for cell-1",
						decidedAt: "2022-06-02",
						evidence: { source: "operator-log-2022" },
					},
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(
			reportLines(dossier).filter((line) => line.part === ReportPart.Outcomes && line.text.startsWith("- fact"))
		).toEqual([
			{
				text: "- fact (operator-log-2022): 1 of 2 dispositions awaits an outcome.",
				part: ReportPart.Outcomes,
				kind: ReportLineKind.Conclusion,
				sources: ["operator-log-2022"],
			},
		])
	})

	test("a conclusion whose statement cites no record prints source unstated and stays a conclusion", () => {
		const built = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		// A hand-built outcome report whose pending disposition gives no record.
		const dossier: Dossier = {
			...built,
			outcomes: { ...built.outcomes, dispositions: 2, pending: 1, pendingSources: [] },
		}

		expect(
			reportLines(dossier).filter((line) => line.part === ReportPart.Outcomes && line.text.startsWith("- fact"))
		).toEqual([
			{
				text: "- fact (source unstated): 1 of 2 dispositions awaits an outcome.",
				part: ReportPart.Outcomes,
				kind: ReportLineKind.Conclusion,
				sources: [],
			},
		])

		expect(uncitedConclusions(dossier)).toEqual([
			"Identifiers: example:bin 1001 (source unstated)",
			"Identifiers: example:bin 1002 (source unstated)",
			"- fact (source unstated): 1 of 2 dispositions awaits an outcome.",
		])
	})
})

describe("reportLines: the kind of each line", () => {
	const lines = [
		...reportLines(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })),
		...reportLines(buildDossier(OPP_RECORDS, { asOf: "2023-06-30" })),
	]

	/**
	 * The kinds of the lines with each text, once per distinct kind.
	 */
	const kindsOf = (text: string) => [...new Set(lines.filter((line) => line.text === text).map((line) => line.kind))]

	test.each([
		[ReportLineKind.Heading, "# Building dossier as of 2022-06-30"],
		[ReportLineKind.Heading, "### Units"],
		[ReportLineKind.Heading, "#### Check house-cable: cable keyed at cell-1"],
		[ReportLineKind.Heading, "Answer as of 2022-06-30:"],
		[ReportLineKind.Heading, "Exception at the 2022-03-15 readings, open."],
		[ReportLineKind.Heading, "Explanations checked: identity, access, capacity, installation and route."],
		[ReportLineKind.Heading, "- explanation: route"],
		[ReportLineKind.Heading, "  - supporting:"],
		[ReportLineKind.Heading, "Decisions and outcomes:"],
		[ReportLineKind.Blank, ""],
		[ReportLineKind.Source, "Admitted (4): permit-2021, inspection-2022, survey-2022, operator-log-2022"],
		[ReportLineKind.Source, "Excluded, available after the cutoff (1): manager-2023 (available 2023-02-01)"],
		[ReportLineKind.Source, "Undated, no availability date (1): undated-listing"],
		[ReportLineKind.Conclusion, "Position: -30.00012, -20.00034 (survey-2022), synthetic"],
		[
			ReportLineKind.Conclusion,
			"Position: unresolved — 2 positions state 2 different locations (-30.00021, -20.00032 per permit-2021, synthetic. -30.00025, -20.00041 per survey-2022, synthetic)",
		],
		[ReportLineKind.Conclusion, "- planned: 24 on 2021-05-10 (permit-2021)"],
		[ReportLineKind.Conclusion, "- c1 — premises storeys: 13 (observed, permit-2021, 2021-05-10)"],
		[
			ReportLineKind.Conclusion,
			"- fact (survey-2022): The cable reading over cell-1 as of 2022-03-15 holds 0 records on a source_present basis.",
		],
		[ReportLineKind.Conclusion, "- cable over cell-3 as of 2022-03-15: records present (survey-2022)"],
		[ReportLineKind.Absence, "Identifiers: application id only"],
		[ReportLineKind.Absence, "Position: unresolved — no position on 2023-06-30 for building:nyc-bin-3429422"],
		[ReportLineKind.Absence, "Extents: none"],
		[ReportLineKind.Absence, "- occupied: unresolved — no occupied count on 2022-06-30 for building:example-house"],
		[ReportLineKind.Absence, "Every admitted reading attaches to a building."],
		[ReportLineKind.Absence, "Decisions and outcomes: none on record."],
		[ReportLineKind.Absence, "Checked without a supporting record: identity and capacity."],
		[ReportLineKind.Absence, "  - conflicting: none on record"],
		[
			ReportLineKind.Absence,
			"Ranking: none. The access, installation and route explanations have no documented probability, so each explanation states the next action if it holds and if it fails.",
		],
		[
			ReportLineKind.Absence,
			"Neither a subject nor an admitted membership places these readings at a building, so no building's section shows them.",
		],
		[ReportLineKind.Question, "- How many occupied units does Example House have?"],
		[ReportLineKind.Question, "  - candidates: 0 (survey-2022)"],
		[
			ReportLineKind.Question,
			"  - hypothesis: A provider may have lacked permission to install service at Example House on 2022-03-15.",
		],
		[ReportLineKind.Guidance, "  - would resolve: a dated occupied unit count for Example House"],
		[ReportLineKind.Guidance, "  - missing: the provider's plant record for cell-1"],
		[ReportLineKind.Guidance, "  - if it fails: Investigate access and route next."],
		[ReportLineKind.Derivation, "  - derives from: c1"],
		[
			ReportLineKind.Derivation,
			"  - explanation: A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
		],
	])("%s: %s", (kind, text) => {
		expect(kindsOf(text)).toEqual([kind])
	})

	test("a statement that says no admitted record exists is an absence, and a hypothesis is a question", () => {
		const unread = reportLines(
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					checks: [{ id: "house-fiber", subject: HOUSE, layer: "fiber", extent: "cell-9" }],
					dispositions: [],
				},
				{ asOf: "2022-06-30" }
			)
		)

		// No admitted reading covers cell-9.
		// The permission in force covers one entrance, and the permit's construction window states no end.
		expect(
			unread
				.filter((line) => line.kind === ReportLineKind.Absence && line.part === ReportPart.Checks)
				.map((line) => line.text)
		).toEqual([
			"- fact: No admitted reading of fiber covers cell-9.",
			"- deduction: Without a survey of cell-9, whether fiber service exists there on 2022-06-30 is unknown.",
			"Checked without a supporting record: identity, capacity and route.",
			"  - conflicting: none on record",
			"Ranking: none. The access and installation explanations have no documented probability, so each explanation states the next action if it holds and if it fails.",
			"Decisions and outcomes: none on record.",
		])

		expect(
			unread
				.filter((line) => line.part === ReportPart.Outcomes && line.text.startsWith("- "))
				.map((line) => [line.kind, line.text])
		).toEqual([
			[ReportLineKind.Absence, "- deduction: Blocker accuracy is unknown because no disposition records an outcome."],
			[
				ReportLineKind.Absence,
				"- deduction: Time saved is unknown because no outcome records both the minutes spent and the operator's baseline.",
			],
		])
	})

	test("an unresolved question and its candidates carry the records they rest on", () => {
		const annex = sectionRecords(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), "building:example-annex")

		expect(
			annex
				.filter(
					(line) =>
						line.part === ReportPart.Unresolved &&
						(line.kind === ReportLineKind.Question || line.kind === ReportLineKind.Guidance)
				)
				.slice(0, 3)
		).toMatchObject([
			{ text: "- Where is Example Annex?", kind: ReportLineKind.Question, sources: ["permit-2021", "survey-2022"] },
			{
				text: "  - candidates: -30.00021, -20.00032 (permit-2021). -30.00025, -20.00041 (survey-2022)",
				kind: ReportLineKind.Question,
				sources: ["permit-2021", "survey-2022"],
			},
			{
				text: "  - would resolve: a record that settles which of the 2 positions locates Example Annex",
				kind: ReportLineKind.Guidance,
				sources: [],
			},
		])
	})
})

describe("reportLines: the sources part", () => {
	test("ends the report and lists each admitted source record with its publisher, title and three dates", () => {
		const lines = reportLines(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))
		const sources = lines.filter((line) => line.part === ReportPart.Sources)

		expect(lines.slice(-sources.length)).toEqual(sources)

		expect(sources.map((line) => [line.kind, line.text, line.sources])).toEqual([
			[ReportLineKind.Heading, "## Sources", []],
			[ReportLineKind.Blank, "", []],
			[
				ReportLineKind.Source,
				'- permit-2021: Example City Buildings Department, "New building permit" (observed 2021-05-10, available 2021-05-12, retrieved 2026-10-04)',
				["permit-2021"],
			],
			[
				ReportLineKind.Source,
				'- inspection-2022: Example City Buildings Department, "Inspection record" (observed 2022-04-01, available 2022-04-03, retrieved 2026-10-04)',
				["inspection-2022"],
			],
			[
				ReportLineKind.Source,
				'- survey-2022: Example Surveyor, "Entrance survey" (observed 2022-03-15, available 2022-03-20, retrieved 2026-10-04)',
				["survey-2022"],
			],
			[
				ReportLineKind.Source,
				'- operator-log-2022: Example Operator, "Investigation log" (observed 2022-06-20, available 2022-06-25, retrieved 2026-10-04)',
				["operator-log-2022"],
			],
			[ReportLineKind.Blank, "", []],
		])
	})

	test("gives a record's URL when it has one and prints undated for each missing date", () => {
		const opp = reportLines(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" }))

		expect(lineStarting(opp, "- pad-geosearch-26c:").text).toBe(
			'- pad-geosearch-26c: NYC Planning, "Geosearch / PAD 26c — 11 Ocean Parkway", https://geosearch.planninglabs.nyc/v2/search?text=11%20OCEAN%20PARKWAY%2C%20Brooklyn (observed undated, available 2026-10-05, retrieved 2026-10-05)'
		)

		const unretrieved = reportLines(
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					sources: [
						...EXAMPLE_RECORDS.sources,
						{ id: "listing-2022", publisher: "Example Listings", title: "Dated listing", availableAt: "2022-01-03" },
					],
				},
				{ asOf: "2022-06-30" }
			)
		)

		expect(lineStarting(unretrieved, "- listing-2022:").text).toBe(
			'- listing-2022: Example Listings, "Dated listing" (observed undated, available 2022-01-03, retrieved undated)'
		)
	})

	test("an empty dossier states that no source record is admitted", () => {
		const lines = reportLines(buildDossier(EMPTY_RECORDS, { asOf: "2022-06-30" }))

		expect(lines.filter((line) => line.part === ReportPart.Sources).map((line) => [line.kind, line.text])).toEqual([
			[ReportLineKind.Heading, "## Sources"],
			[ReportLineKind.Blank, ""],
			[ReportLineKind.Absence, "No source record is admitted."],
			[ReportLineKind.Blank, ""],
		])
	})
})
