/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type EntityID, renderReport, ReportLineKind, reportLines, validateRecords } from "@mailwoman/dossier"
import { osgb36ToWGS84 } from "@mailwoman/spatial/osgb36"
import { describe, expect, test } from "vitest"

import {
	ADDISCOMBE_GROVE,
	CRICKLEWOOD_LANE,
	FLOOD_MAP,
	LONDON_AS_OF,
	LONDON_RECORDS,
	LONDON_SITES,
	londonDossier,
	NSUL,
	OFCOM_OUTPUT_AREAS_ALL,
	OFCOM_OUTPUT_AREAS_RESIDENTIAL,
	OFCOM_POSTCODES_ALL,
	OFCOM_POSTCODES_RESIDENTIAL,
	ONSPD,
	PENTONVILLE_ROAD,
	siteFloodRecords,
} from "#test/fixtures/london-three-buildings"

const dossier = londonDossier()

function sectionOf(building: EntityID) {
	return dossier.buildings.find((section) => section.building.id === building)!
}

const OFCOM_SOURCES = [
	OFCOM_POSTCODES_ALL,
	OFCOM_POSTCODES_RESIDENTIAL,
	OFCOM_OUTPUT_AREAS_ALL,
	OFCOM_OUTPUT_AREAS_RESIDENTIAL,
]

describe("the three London buildings as one dossier", () => {
	test("validates without an issue and admits every source record on 2026-10-05", () => {
		expect(validateRecords(LONDON_RECORDS)).toEqual([])
		expect(dossier.asOf).toBe(LONDON_AS_OF)
		expect(dossier.admitted).toEqual(LONDON_RECORDS.sources.map((source) => source.id))
		expect(dossier.excluded).toEqual([])
		expect(dossier.undated).toEqual([])
		expect(dossier.unplaced).toEqual([])
	})

	test("holds no synthetic position, no check, no provider record and no completed or occupied count", () => {
		expect(LONDON_RECORDS.positions!.map((position) => position.synthetic)).toEqual([false, false, false])
		expect(LONDON_RECORDS.checks).toEqual([])
		expect(LONDON_RECORDS.availability).toEqual([])
		expect(new Set(LONDON_RECORDS.counts.map((count) => count.stage))).toEqual(new Set(["planned"]))
	})

	test("names each building by its planning authority's reference, cited to its planning row, and its site address", () => {
		expect(
			dossier.buildings.map((section) => [
				section.building.label,
				section.identifiers,
				section.aliases.map((alias) => alias.text),
			])
		).toEqual([
			[
				"28-30 Addiscombe Grove",
				[
					{
						namespace: "croydon:planning-application",
						value: "17/02680/FUL",
						evidence: { source: "ldd-17-02680-ful" },
					},
				],
				["28-30 Addiscombe Grove, CR0 5LP"],
			],
			[
				"112-132 Cricklewood Lane",
				[
					{
						namespace: "barnet:planning-application",
						value: "16/0601/FUL",
						evidence: { source: "ldd-16-0601-ful" },
					},
				],
				["112-132 Cricklewood Lane, NW2 2DP"],
			],
			[
				"130-154, 154a Pentonville Road",
				[
					{
						namespace: "islington:planning-application",
						value: "P2014/1017/FUL",
						evidence: { source: "ldd-p2014-1017-ful" },
					},
				],
				["130-154, 154a Pentonville Road, N1 9JE"],
			],
		])

		expect(dossier.buildings.map((section) => section.identifiers)).toEqual(
			dossier.buildings.map((section) => section.building.externalIDs)
		)
	})

	test("places each building at its planning grid reference, converted with osgb36ToWGS84", () => {
		for (const entry of LONDON_SITES) {
			const { latitude, longitude } = osgb36ToWGS84(entry.grid)

			expect(sectionOf(entry.building).position).toEqual({
				status: "resolved",
				latitude,
				longitude,
				synthetic: false,
				positions: [
					{ subject: entry.building, latitude, longitude, synthetic: false, evidence: { source: entry.ldd } },
				],
			})
		}

		// The converted points of the three grid references, to about 0.1 m.
		expect(
			[ADDISCOMBE_GROVE, CRICKLEWOOD_LANE, PENTONVILLE_ROAD].map((building) => {
				const position = sectionOf(building).position

				return position.status === "resolved" ? [position.latitude, position.longitude] : []
			})
		).toEqual([
			[expect.closeTo(51.37444, 6), expect.closeTo(-0.090279, 6)],
			[expect.closeTo(51.55972, 6), expect.closeTo(-0.209208, 6)],
			[expect.closeTo(51.531708, 6), expect.closeTo(-0.113333, 6)],
		])
	})

	test("records the planning authority and postcode that each planning row states, and no output-area membership", () => {
		expect(
			dossier.buildings.map((section) =>
				section.memberships.map((membership) => [membership.extent, membership.evidence.source])
			)
		).toEqual([
			[
				["planning-authority:Croydon", "ldd-17-02680-ful"],
				["postcode:CR0 5LP", "ldd-17-02680-ful"],
			],
			[
				["planning-authority:Barnet", "ldd-16-0601-ful"],
				["postcode:NW2 2DP", "ldd-16-0601-ful"],
			],
			[
				["planning-authority:Islington", "ldd-p2014-1017-ful"],
				["postcode:N1 9JE", "ldd-p2014-1017-ful"],
			],
		])

		expect(LONDON_RECORDS.memberships!.filter((membership) => membership.extent.startsWith("output-area:"))).toEqual([])
	})

	test("resolves a planned total from one count or from two that agree, and keeps two that disagree unresolved", () => {
		expect(sectionOf(ADDISCOMBE_GROVE).counts.planned).toMatchObject({
			status: "resolved",
			at: "2018-02-20",
			total: 153,
			parts: [
				{ count: 153, evidence: { source: "ldd-17-02680-ful" } },
				{ count: 153, evidence: { source: "gla-referral-3831a" } },
			],
		})

		expect(sectionOf(CRICKLEWOOD_LANE).counts.planned).toMatchObject({
			status: "resolved",
			at: "2016-08-30",
			total: 122,
			parts: [{ count: 122, evidence: { source: "ldd-16-0601-ful" } }],
		})

		expect(sectionOf(PENTONVILLE_ROAD).counts.planned).toMatchObject({
			status: "unresolved",
			at: "2014-12-12",
			reason:
				"2 counts share the same subject, stage, date and membership (islington-p2014-1017-ful:residential-units) and disagree: 119 versus 118",
			conflicting: [
				{ count: 119, evidence: { source: "ldd-p2014-1017-ful" } },
				{ count: 118, evidence: { source: "gla-referral-2924b" } },
			],
		})

		for (const section of dossier.buildings) {
			expect(section.counts.completed.status).toBe("unresolved")
			expect(section.counts.occupied.status).toBe("unresolved")
		}
	})

	test("dates each building's construction from the planning row's start and completion dates", () => {
		expect(dossier.buildings.map((section) => section.windows)).toEqual(
			LONDON_SITES.map((entry) => [
				{
					subject: entry.building,
					start: entry.started,
					end: entry.completed,
					stage: "construction",
					evidence: { source: entry.ldd },
				},
			])
		)
	})
})

describe("the three London buildings: claims", () => {
	test("each building holds its planning row's observed claims, its inferred postcodes and output areas, its Ofcom figures and its flood zone", () => {
		expect(
			dossier.buildings.map((section) => {
				const tally: Record<string, number> = {}

				for (const claim of section.claims) {
					const kind = `${claim.status} ${claim.predicate}`

					tally[kind] = (tally[kind] ?? 0) + 1
				}

				return tally
			})
		).toEqual([
			{
				"observed site_grid_reference": 1,
				"observed site_postcode": 1,
				"observed permission_date": 1,
				"inferred postcode": 2,
				"inferred output_area": 1,
				"inferred area_gigabit_availability": 7,
				"designated flood_zone": 1,
			},
			{
				"observed site_grid_reference": 1,
				"observed site_postcode": 1,
				"observed permission_date": 1,
				"inferred postcode": 2,
				"inferred output_area": 1,
				"inferred area_gigabit_availability": 8,
				"designated flood_zone": 1,
			},
			{
				"observed site_grid_reference": 1,
				"observed site_postcode": 1,
				"observed permission_date": 1,
				"observed existing_residential_units": 1,
				"inferred postcode": 4,
				"inferred output_area": 2,
				"inferred area_gigabit_availability": 12,
				"designated flood_zone": 1,
			},
		])
	})

	test("an inferred postcode derives from the grid reference and the permission date, and cites NSUL", () => {
		const claims = sectionOf(PENTONVILLE_ROAD).claims.filter((claim) => claim.predicate === "postcode")

		expect(claims.map((claim) => claim.value)).toEqual(["N1 9FS", "N1 9FW", "N1 9FT", "N1 9FU"])

		expect(claims[1]).toEqual({
			id: "islington-p2014-1017-ful:postcode:N1 9FW",
			subject: PENTONVILLE_ROAD,
			axis: "identity",
			predicate: "postcode",
			value: "N1 9FW",
			status: "inferred",
			derivedFrom: ["islington-p2014-1017-ful:site-grid-reference", "islington-p2014-1017-ful:permission-date"],
			explanation:
				"ONSPD dates the introduction of N1 9FW to 2018-06, after the permission date, and NSUL places 4 of the 6 UPRNs with that postcode within 50 m of the planning grid reference. The link rests on proximity and introduction date, and no published record links the planning record to the postcode.",
			evidence: { source: NSUL },
		})
	})

	test("an inferred output area derives from the postcodes ONSPD assigns to it, and the planning postcode of 130-154, 154a Pentonville Road gives its own", () => {
		expect(
			dossier.buildings.map((section) =>
				section.claims
					.filter((claim) => claim.predicate === "output_area")
					.map((claim) => [
						claim.value,
						claim.status,
						claim.evidence.source,
						"derivedFrom" in claim ? claim.derivedFrom : [],
					])
			)
		).toEqual([
			[
				[
					"E00005233",
					"inferred",
					ONSPD,
					[
						"croydon-17-02680-ful:site-postcode",
						"croydon-17-02680-ful:postcode:CR0 5BX",
						"croydon-17-02680-ful:postcode:CR0 5BY",
					],
				],
			],
			[
				[
					"E00178816",
					"inferred",
					ONSPD,
					[
						"barnet-16-0601-ful:site-postcode",
						"barnet-16-0601-ful:postcode:NW2 2DL",
						"barnet-16-0601-ful:postcode:NW2 2DW",
					],
				],
			],
			[
				[
					"E00174805",
					"inferred",
					ONSPD,
					[
						"islington-p2014-1017-ful:postcode:N1 9FS",
						"islington-p2014-1017-ful:postcode:N1 9FW",
						"islington-p2014-1017-ful:postcode:N1 9FT",
						"islington-p2014-1017-ful:postcode:N1 9FU",
					],
				],
				["E00174843", "inferred", ONSPD, ["islington-p2014-1017-ful:site-postcode"]],
			],
		])
	})

	test("an Ofcom figure is an inferred network claim on one area and one premises set, never a reading", () => {
		const figures = LONDON_RECORDS.claims.filter((claim) => claim.predicate === "area_gigabit_availability")

		expect(figures).toHaveLength(27)

		for (const claim of figures) {
			expect(claim).toMatchObject({ axis: "network", status: "inferred" })
			expect(OFCOM_SOURCES).toContain(claim.evidence.source)
		}

		expect(LONDON_RECORDS.readings.map((reading) => reading.evidence.source)).toEqual([FLOOD_MAP, FLOOD_MAP, FLOOD_MAP])
	})

	test("an output-area figure states the published premises and gigabit counts, and a postcode figure marks its premises count unpublished", () => {
		const values = (building: EntityID) =>
			sectionOf(building)
				.claims.filter((claim) => claim.predicate === "area_gigabit_availability")
				.map((claim) => [claim.evidence.source, claim.value])

		expect(values(ADDISCOMBE_GROVE)).toEqual([
			[
				OFCOM_POSTCODES_ALL,
				{ extent: "postcode:CR0 5BX", premisesSet: "all", premises: "unpublished", gigabitPercent: 100 },
			],
			[
				OFCOM_POSTCODES_RESIDENTIAL,
				{ extent: "postcode:CR0 5BX", premisesSet: "residential", premises: "unpublished", gigabitPercent: 100 },
			],
			[
				OFCOM_POSTCODES_ALL,
				{ extent: "postcode:CR0 5BY", premisesSet: "all", premises: "unpublished", gigabitPercent: 100 },
			],
			[
				OFCOM_POSTCODES_RESIDENTIAL,
				{ extent: "postcode:CR0 5BY", premisesSet: "residential", premises: "unpublished", gigabitPercent: 100 },
			],
			[
				OFCOM_POSTCODES_ALL,
				{ extent: "postcode:CR0 5LP", premisesSet: "all", premises: "unpublished", gigabitPercent: 0 },
			],
			[
				OFCOM_OUTPUT_AREAS_ALL,
				{ extent: "output-area:E00005233", premisesSet: "all", premises: 509, gigabitPremises: 371 },
			],
			[
				OFCOM_OUTPUT_AREAS_RESIDENTIAL,
				{ extent: "output-area:E00005233", premisesSet: "residential", premises: 447, gigabitPremises: 363 },
			],
		])

		expect(
			values(CRICKLEWOOD_LANE).filter(([, value]) => (value as { extent: string }).extent === "postcode:NW2 2DP")
		).toEqual([
			[
				OFCOM_POSTCODES_ALL,
				{ extent: "postcode:NW2 2DP", premisesSet: "all", premises: "unpublished", gigabitPercent: 96.4 },
			],
			[
				OFCOM_POSTCODES_RESIDENTIAL,
				{ extent: "postcode:NW2 2DP", premisesSet: "residential", premises: "unpublished", gigabitPercent: 95.8 },
			],
		])

		expect(
			values(PENTONVILLE_ROAD).filter(([, value]) => (value as { extent: string }).extent.startsWith("output-area:"))
		).toEqual([
			[
				OFCOM_OUTPUT_AREAS_ALL,
				{ extent: "output-area:E00174805", premisesSet: "all", premises: 163, gigabitPremises: 160 },
			],
			[
				OFCOM_OUTPUT_AREAS_RESIDENTIAL,
				{ extent: "output-area:E00174805", premisesSet: "residential", premises: 150, gigabitPremises: 150 },
			],
			[
				OFCOM_OUTPUT_AREAS_ALL,
				{ extent: "output-area:E00174843", premisesSet: "all", premises: 88, gigabitPremises: 82 },
			],
			[
				OFCOM_OUTPUT_AREAS_RESIDENTIAL,
				{ extent: "output-area:E00174843", premisesSet: "residential", premises: 74, gigabitPremises: 70 },
			],
		])
	})

	test("a postcode the residential file does not report has no residential figure, never a zero", () => {
		const residentialPostcodes = LONDON_RECORDS.claims.flatMap((claim) => {
			const value = claim.value as { extent?: string; premisesSet?: string }

			return value.premisesSet === "residential" && value.extent?.startsWith("postcode:") ? [value.extent] : []
		})

		expect(residentialPostcodes).toEqual([
			"postcode:CR0 5BX",
			"postcode:CR0 5BY",
			"postcode:NW2 2DL",
			"postcode:NW2 2DW",
			"postcode:NW2 2DP",
			"postcode:N1 9FS",
			"postcode:N1 9FT",
			"postcode:N1 9FU",
		])
	})

	test("every figure derives from the claim that links the building to its area, and every inferred claim explains its link", () => {
		const ids = new Set(LONDON_RECORDS.claims.map((claim) => claim.id))

		for (const claim of LONDON_RECORDS.claims) {
			if (claim.status !== "inferred") continue

			expect(claim.derivedFrom.length).toBeGreaterThan(0)
			expect(claim.derivedFrom.every((parent) => ids.has(parent))).toBe(true)
			expect(claim.explanation).toMatch(/inferred|rests on/)
		}
	})
})

describe("the three London buildings: flood readings", () => {
	test("each building's flood reading attaches by its subject and establishes the absence of a flood zone at its position", () => {
		for (const entry of LONDON_SITES) {
			const { reading } = siteFloodRecords(entry)

			expect(sectionOf(entry.building).readings).toEqual([
				{
					layer: "flood-zones-ea-england",
					extent: reading.extent,
					surveyedAt: "2026-05-20",
					class: "surveyed_empty",
					sources: [FLOOD_MAP],
				},
			])

			expect(reading).toMatchObject({ subject: entry.building, basis: "designated", records: 0 })
		}
	})

	test("each building holds a designated Zone 1 claim from the flood map", () => {
		expect(
			dossier.buildings.map((section) =>
				section.claims
					.filter((claim) => claim.predicate === "flood_zone")
					.map((claim) => [claim.id, claim.value, claim.status, claim.evidence.source])
			)
		).toEqual([
			[["flood-zones-ea-england:building:croydon-17-02680-ful:2026-05-20", "FZ1", "designated", FLOOD_MAP]],
			[["flood-zones-ea-england:building:barnet-16-0601-ful:2026-05-20", "FZ1", "designated", FLOOD_MAP]],
			[["flood-zones-ea-england:building:islington-p2014-1017-ful:2026-05-20", "FZ1", "designated", FLOOD_MAP]],
		])
	})

	test("the flood map's record takes its three dates from the database manifest", () => {
		expect(LONDON_RECORDS.sources.find((source) => source.id === FLOOD_MAP)).toMatchObject({
			observedAt: "2026-05-20",
			availableAt: "2026-05-20",
			retrievedAt: "2026-08-28T01:46:44.206Z",
		})
	})
})

describe("the three London buildings: the report", () => {
	const report = renderReport(dossier)

	test("prints each claim with its source record and evidence date", () => {
		expect(report).toContain(
			'- croydon-17-02680-ful:gigabit:all:output-area:E00005233 — network area_gigabit_availability: { extent: "output-area:E00005233", premisesSet: "all", premises: 509, gigabitPremises: 371 } (inferred, ofcom-2026-01-output-area-all-r1, 2026-01-31)'
		)

		expect(report).toContain(
			'- islington-p2014-1017-ful:output-area:E00174843 — identity output_area: "E00174843" (inferred, onspd-2026-02, undated)'
		)

		expect(report).toContain(
			'- flood-zones-ea-england:building:barnet-16-0601-ful:2026-05-20 — premises flood_zone: "FZ1" (designated, ea-flood-map-2026-05-20, 2026-05-20)'
		)
	})

	test("every conclusion cites a source record the dossier admitted, and its text gives each record it cites", () => {
		const admitted = new Set(dossier.admitted)
		const conclusions = reportLines(dossier).filter((line) => line.kind === ReportLineKind.Conclusion)

		expect(conclusions.length).toBeGreaterThan(0)

		expect(
			conclusions.filter((line) => !line.sources.some((source) => admitted.has(source))).map((line) => line.text)
		).toEqual([])

		expect(
			conclusions
				.filter((line) => !line.sources.every((source) => admitted.has(source) && line.text.includes(source)))
				.map((line) => line.text)
		).toEqual([])

		expect(report).not.toContain("source unstated")
	})

	test("cites each building's identifier to its planning row and lists each admitted record in the sources part", () => {
		expect(report).toContain("Identifiers: croydon:planning-application 17/02680/FUL (ldd-17-02680-ful)")
		expect(report).toContain("Identifiers: barnet:planning-application 16/0601/FUL (ldd-16-0601-ful)")
		expect(report).toContain("Identifiers: islington:planning-application P2014/1017/FUL (ldd-p2014-1017-ful)")

		expect(
			reportLines(dossier)
				.filter((line) => line.kind === ReportLineKind.Source && line.text.startsWith("- "))
				.map((line) => line.sources)
		).toEqual(dossier.admitted.map((source) => [source]))
	})

	test("lists the unresolved unit totals as each building's open questions", () => {
		expect(dossier.buildings.map((section) => section.unresolved.map((item) => item.question))).toEqual([
			[
				"How many completed units does 28-30 Addiscombe Grove have?",
				"How many occupied units does 28-30 Addiscombe Grove have?",
			],
			[
				"How many completed units does 112-132 Cricklewood Lane have?",
				"How many occupied units does 112-132 Cricklewood Lane have?",
			],
			[
				"How many planned units does 130-154, 154a Pentonville Road have?",
				"How many completed units does 130-154, 154a Pentonville Road have?",
				"How many occupied units does 130-154, 154a Pentonville Road have?",
			],
		])
	})
})
