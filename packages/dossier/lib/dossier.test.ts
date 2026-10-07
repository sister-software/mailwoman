/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import { buildDossier, type Dossier } from "#dossier"
import type { EntityID } from "#identifiers"
import {
	ANNEX,
	ANNEX_PERMIT_POSITION,
	ANNEX_SURVEY_POSITION,
	EXAMPLE_RECORDS,
	HOUSE,
	HOUSE_POSITION,
	MISSING_READING,
	NORTH,
} from "#test/fixtures/example-house"
import { OPP_BUILDING, OPP_RECORDS } from "#test/fixtures/one-park-point"
import type { DossierRecords } from "#validate"

function sectionOf(dossier: Dossier, building: EntityID) {
	return dossier.buildings.find((section) => section.building.id === building)!
}

function layersAndExtents(dossier: Dossier, building: EntityID): string[][] {
	return sectionOf(dossier, building).readings.map((reading) => [reading.layer, reading.extent])
}

/**
 * A surveyed-empty reading over `cell-2`, an extent the Example House fixture never reads.
 */
function cell2Reading(overrides: Partial<LayerReading>): LayerReading {
	return {
		layer: "ducts",
		extent: "cell-2",
		basis: "surveyed",
		surveyedAt: "2022-03-15",
		records: 0,
		evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
		subject: null,
		...overrides,
	}
}

describe("buildDossier as of 2022-06-30", () => {
	const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })
	const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

	test("admits the permit, inspection, survey and operator log. Excludes the 2023 statement. Lists the undated listing", () => {
		expect(dossier.admitted).toEqual(["permit-2021", "inspection-2022", "survey-2022", "operator-log-2022"])
		expect(dossier.excluded).toEqual([{ id: "manager-2023", availableAt: "2023-02-01", observedAt: "2023-02-01" }])
		expect(dossier.undated).toEqual(["undated-listing"])
	})

	test("the 2023 occupied count and the undated 22 do not reach the sections", () => {
		expect(house.counts.occupied).toMatchObject({
			status: "unresolved",
			reason: expect.stringMatching(/no occupied count/),
		})

		expect(house.counts.completed).toMatchObject({ status: "resolved", total: 20 })
	})

	test("the north entrance permission is scoped to the entrance", () => {
		expect(house.permissions.map((event) => event.scope)).toEqual([[NORTH]])
	})

	test("signing authority and the open construction window are unresolved with the record that would resolve them", () => {
		const questions = house.unresolved.map((item) => item.question)

		expect(questions).toContainEqual(expect.stringMatching(/Example Holdings LLC.*signing authority/))
		expect(questions).toContainEqual(expect.stringMatching(/construction window.*no end/))
		expect(house.unresolved.every((item) => item.missingRecord.length > 0)).toBe(true)
	})

	test("a record observed before the cutoff but available after it is excluded", () => {
		const late = buildDossier(
			{
				...EXAMPLE_RECORDS,
				sources: [
					...EXAMPLE_RECORDS.sources,
					{
						id: "late",
						publisher: "p",
						title: "t",
						observedAt: "2022-01-01",
						availableAt: "2022-12-01",
						url: null,
						retrievedAt: null,
					},
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(late.excluded).toContainEqual({ id: "late", availableAt: "2022-12-01", observedAt: "2022-01-01" })
	})

	test("refuses records with a validation error", () => {
		expect(() =>
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					containment: [
						{
							child: "entrance:ghost",
							parent: HOUSE,
							relation: "entrance_of",
							evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
						},
					],
				},
				{ asOf: "2022-06-30" }
			)
		).toThrow(/unknown_entity/)
	})
})

describe("buildDossier: the building a layer reading attaches to", () => {
	test("a reading with a subject attaches to that building and to no other", () => {
		const dossier = buildDossier(
			{ ...EXAMPLE_RECORDS, readings: [...EXAMPLE_RECORDS.readings, cell2Reading({ subject: ANNEX })] },
			{ asOf: "2022-06-30" }
		)

		expect(sectionOf(dossier, ANNEX).readings).toContainEqual({
			layer: "ducts",
			extent: "cell-2",
			surveyedAt: "2022-03-15",
			class: "surveyed_empty",
			sources: ["survey-2022"],
		})

		expect(sectionOf(dossier, HOUSE).readings.map((reading) => reading.extent)).not.toContain("cell-2")
	})

	test("a reading without a subject attaches to each building that an admitted membership places in its extent", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		expect(EXAMPLE_RECORDS.readings.every((reading) => reading.subject === null)).toBe(true)

		expect(layersAndExtents(dossier, HOUSE)).toEqual([
			["ducts", "cell-1"],
			["cabinets", "cell-1"],
			["poles", "cell-1"],
			["cable", "cell-1"],
			["cable", "district-1"],
		])

		expect(layersAndExtents(dossier, ANNEX)).toEqual([["cable", "district-1"]])
	})

	test("a reading that neither rule places is listed as unplaced and appears in no building's section", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		expect(dossier.unplaced).toEqual([
			{ layer: "cable", extent: "cell-3", surveyedAt: "2022-03-15", class: "records", sources: ["survey-2022"] },
		])

		for (const building of [HOUSE, ANNEX]) {
			expect(sectionOf(dossier, building).readings.map((reading) => reading.extent)).not.toContain("cell-3")
		}
	})

	test("a membership places a reading only once its source is admitted", () => {
		const records = {
			...EXAMPLE_RECORDS,
			memberships: [
				...EXAMPLE_RECORDS.memberships!,
				{
					subject: ANNEX,
					extent: "cell-3",
					evidence: { source: "manager-2023", observedAt: null, validFrom: null, validTo: null },
				},
			],
		}

		const before = buildDossier(records, { asOf: "2022-06-30" })

		expect(before.unplaced.map((reading) => reading.extent)).toEqual(["cell-3"])
		expect(layersAndExtents(before, ANNEX)).toEqual([["cable", "district-1"]])

		const after = buildDossier(records, { asOf: "2023-06-30" })

		expect(after.unplaced).toEqual([])

		expect(layersAndExtents(after, ANNEX)).toEqual([
			["cable", "district-1"],
			["cable", "cell-3"],
		])

		expect(sectionOf(after, ANNEX).memberships.map((membership) => membership.extent)).toEqual(["district-1", "cell-3"])
	})

	test("a reading with a subject attaches to its subject alone, even where a membership places another building", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [...EXAMPLE_RECORDS.readings, cell2Reading({ extent: "district-1", subject: HOUSE })],
			},
			{ asOf: "2022-06-30" }
		)

		expect(layersAndExtents(dossier, HOUSE)).toContainEqual(["ducts", "district-1"])
		expect(layersAndExtents(dossier, ANNEX)).toEqual([["cable", "district-1"]])
	})

	test("two vintages of one layer and extent for one subject stay two readings", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [
					cell2Reading({ subject: HOUSE, basis: "source_present", surveyedAt: "2021-03-15", records: 0 }),
					cell2Reading({ subject: HOUSE, basis: "source_present", surveyedAt: "2022-03-15", records: 3 }),
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(sectionOf(dossier, HOUSE).readings).toEqual([
			{
				layer: "ducts",
				extent: "cell-2",
				surveyedAt: "2021-03-15",
				class: "source_present_empty",
				sources: ["survey-2022"],
			},
			{ layer: "ducts", extent: "cell-2", surveyedAt: "2022-03-15", class: "records", sources: ["survey-2022"] },
		])

		expect(sectionOf(dossier, ANNEX).readings).toEqual([])
	})

	test("a layer and extent whose texts concatenate alike stay two readings", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [
					cell2Reading({ layer: "duct", extent: "s-cell", subject: HOUSE }),
					cell2Reading({ layer: "ducts", extent: "-cell", subject: HOUSE }),
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(layersAndExtents(dossier, HOUSE)).toEqual([
			["duct", "s-cell"],
			["ducts", "-cell"],
		])
	})

	test("refuses a reading whose subject is not a building", () => {
		expect(() =>
			buildDossier({ ...EXAMPLE_RECORDS, readings: [cell2Reading({ subject: NORTH })] }, { asOf: "2022-06-30" })
		).toThrow(/subject_not_building/)
	})

	test("refuses a membership whose subject is not a building", () => {
		expect(() =>
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					memberships: [
						{
							subject: NORTH,
							extent: "cell-1",
							evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
						},
					],
				},
				{ asOf: "2022-06-30" }
			)
		).toThrow(/subject_not_building/)
	})
})

describe("buildDossier: a building's external identifiers", () => {
	/**
	 * Example House with a BIN the permit states, a UPRN the 2023 manager statement states,
	 * and a listing number that states no evidence.
	 */
	const records: DossierRecords = {
		...EXAMPLE_RECORDS,
		entities: EXAMPLE_RECORDS.entities.map((entity) =>
			entity.id === HOUSE
				? {
						...entity,
						externalIDs: [
							{
								namespace: "example:bin",
								value: "1001",
								evidence: { source: "permit-2021", observedAt: null, validFrom: null, validTo: null },
							},
							{
								namespace: "example:uprn",
								value: "77",
								evidence: { source: "manager-2023", observedAt: null, validFrom: null, validTo: null },
							},
							{ namespace: "example:listing", value: "L-9", evidence: null },
						],
					}
				: entity
		),
	}

	test("a section keeps an identifier with admitted evidence and one without evidence, and leaves out one whose evidence it excludes", () => {
		expect(sectionOf(buildDossier(records, { asOf: "2022-06-30" }), HOUSE).identifiers).toEqual([
			{
				namespace: "example:bin",
				value: "1001",
				evidence: { source: "permit-2021", observedAt: null, validFrom: null, validTo: null },
			},
			{ namespace: "example:listing", value: "L-9", evidence: null },
		])

		expect(
			sectionOf(buildDossier(records, { asOf: "2023-06-30" }), HOUSE).identifiers.map((id) => id.namespace)
		).toEqual(["example:bin", "example:uprn", "example:listing"])
	})

	test("an identifier whose source record is undated stays out, as the record does", () => {
		const undated: DossierRecords = {
			...records,
			entities: records.entities.map((entity) =>
				entity.id === ANNEX
					? {
							...entity,
							externalIDs: [
								{
									...entity.externalIDs[0]!,
									evidence: { source: "undated-listing", observedAt: null, validFrom: null, validTo: null },
								},
							],
						}
					: entity
			),
		}

		expect(sectionOf(buildDossier(undated, { asOf: "2026-10-05" }), ANNEX).identifiers).toEqual([])
	})

	test("One Park Point's BIN waits for the Geosearch record that states it", () => {
		expect(sectionOf(buildDossier(OPP_RECORDS, { asOf: "2023-06-30" }), OPP_BUILDING).identifiers).toEqual([])

		expect(sectionOf(buildDossier(OPP_RECORDS, { asOf: "2026-10-05" }), OPP_BUILDING).identifiers).toEqual([
			{
				namespace: "nyc:bin",
				value: "3429422",
				evidence: { source: "pad-geosearch-26c", observedAt: null, validFrom: null, validTo: null },
			},
		])
	})
})

describe("buildDossier: the records behind a section's readings and questions", () => {
	test("each reading group lists the admitted source records of its readings, each once", () => {
		const dossier = buildDossier(
			{
				...EXAMPLE_RECORDS,
				readings: [
					...EXAMPLE_RECORDS.readings,
					{
						...MISSING_READING,
						evidence: { source: "inspection-2022", observedAt: null, validFrom: null, validTo: null },
					},
					{ ...MISSING_READING, evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null } },
				],
			},
			{ asOf: "2022-06-30" }
		)

		expect(
			sectionOf(dossier, HOUSE).readings.map((reading) => [reading.layer, reading.extent, reading.sources])
		).toEqual([
			["ducts", "cell-1", ["survey-2022", "inspection-2022"]],
			["cabinets", "cell-1", ["survey-2022"]],
			["poles", "cell-1", ["survey-2022"]],
			["cable", "cell-1", ["survey-2022"]],
			["cable", "district-1", ["survey-2022"]],
		])
	})

	test("an unresolved question lists the admitted records it rests on, and none when no record bears on it", () => {
		const house = sectionOf(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), HOUSE)

		expect(house.unresolved.map((item) => [item.question, item.sources])).toEqual([
			["How many occupied units does Example House have?", []],
			["Does Example Holdings LLC (owner) hold signing authority for Example House?", ["permit-2021"]],
			[
				"When does the construction window that opened 2021-06-01 (permit issued) close? The record states no end.",
				["permit-2021"],
			],
			["What does the ducts layer hold for cell-1?", ["survey-2022"]],
			["What does the poles layer hold for cell-1?", ["survey-2022"]],
			["What does the cable layer hold for cell-1 as of 2022-03-15?", ["survey-2022"]],
		])
	})
})

describe("buildDossier: building positions", () => {
	const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

	test("one admitted position resolves, and the dossier keeps its synthetic label", () => {
		expect(sectionOf(dossier, HOUSE).position).toEqual({
			status: "resolved",
			latitude: HOUSE_POSITION.latitude,
			longitude: HOUSE_POSITION.longitude,
			synthetic: true,
			positions: [HOUSE_POSITION],
		})

		expect(sectionOf(dossier, HOUSE).unresolved.map((item) => item.question)).not.toContain("Where is Example House?")
	})

	test("two admitted positions that differ stay unresolved, listed with the record that would settle them", () => {
		const annex = sectionOf(dossier, ANNEX)

		expect(annex.position).toEqual({
			status: "unresolved",
			reason: "2 positions state 2 different locations",
			conflicting: [ANNEX_PERMIT_POSITION, ANNEX_SURVEY_POSITION],
		})

		expect(annex.unresolved).toContainEqual({
			question: "Where is Example Annex?",
			subject: ANNEX,
			candidates: ["-30.00021, -20.00032 (permit-2021)", "-30.00025, -20.00041 (survey-2022)"],
			missingRecord: "a record that settles which of the 2 positions locates Example Annex",
			sources: ["permit-2021", "survey-2022"],
		})
	})

	test("a position whose source is not yet available stays out, and a later one that differs unresolves the position", () => {
		const records = {
			...EXAMPLE_RECORDS,
			positions: [
				...EXAMPLE_RECORDS.positions!,
				{
					...HOUSE_POSITION,
					latitude: -30.00015,
					evidence: { source: "manager-2023", observedAt: null, validFrom: null, validTo: null },
				},
			],
		}

		expect(sectionOf(buildDossier(records, { asOf: "2022-06-30" }), HOUSE).position.status).toBe("resolved")

		expect(sectionOf(buildDossier(records, { asOf: "2023-06-30" }), HOUSE).position).toMatchObject({
			status: "unresolved",
			reason: "2 positions state 2 different locations",
		})
	})

	test("refuses a position outside the range of latitude and longitude", () => {
		expect(() =>
			buildDossier({ ...EXAMPLE_RECORDS, positions: [{ ...HOUSE_POSITION, latitude: 91 }] }, { asOf: "2022-06-30" })
		).toThrow(/position_out_of_range/)
	})
})

describe("buildDossier: the claims a section shows", () => {
	/**
	 * The manager's 2023 statement supplies c3.
	 *
	 * The survey's c4 infers from c3, and the permit's c5 derives from c4.
	 */
	const records: DossierRecords = {
		...EXAMPLE_RECORDS,
		claims: [
			...EXAMPLE_RECORDS.claims,
			{
				id: "c3",
				subject: HOUSE,
				axis: "access",
				predicate: "riser_access",
				value: "shared riser",
				status: "observed",
				evidence: { source: "manager-2023", observedAt: null, validFrom: null, validTo: null },
			},
			{
				id: "c4",
				subject: HOUSE,
				axis: "engineering",
				predicate: "riser_route",
				value: "unknown",
				status: "inferred",
				derivedFrom: ["c3"],
				explanation: "A shared riser may not reach the roof.",
				evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
			},
			{
				id: "c5",
				subject: HOUSE,
				axis: "engineering",
				predicate: "riser_route_length_m",
				value: 40,
				status: "derived",
				derivedFrom: ["c4"],
				evidence: { source: "permit-2021", observedAt: null, validFrom: null, validTo: null },
			},
		],
	}

	const claimIDs = (dossier: Dossier, building: EntityID) =>
		sectionOf(dossier, building).claims.map((claim) => claim.id)

	test("an inferred claim appears with the claim it derives from when both records are admitted", () => {
		expect(claimIDs(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), HOUSE)).toEqual(["c1", "c2"])
		expect(claimIDs(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }), ANNEX)).toEqual([])
	})

	test("a derived or inferred claim waits for every claim it derives from, whatever its own record's date", () => {
		expect(claimIDs(buildDossier(records, { asOf: "2022-06-30" }), HOUSE)).toEqual(["c1", "c2"])
		expect(claimIDs(buildDossier(records, { asOf: "2023-06-30" }), HOUSE)).toEqual(["c1", "c2", "c3", "c4", "c5"])
	})

	test("refuses a claim that derives from a claim no record supplies", () => {
		expect(() =>
			buildDossier(
				{
					...EXAMPLE_RECORDS,
					claims: [
						{
							id: "c6",
							subject: HOUSE,
							axis: "network",
							predicate: "nearest_cabinet_connects",
							value: "unknown",
							status: "inferred",
							derivedFrom: ["c9"],
							explanation:
								"A cabinet within 40 m is an observation of proximity, and connection requires its own record.",
							evidence: { source: "survey-2022", observedAt: null, validFrom: null, validTo: null },
						},
					],
				},
				{ asOf: "2022-06-30" }
			)
		).toThrow(/unknown_claim: c6 derives from claim c9, which is not supplied/)
	})

	test("lists the admitted source records in the order of their identifiers", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" })

		expect(dossier.admittedSources.map((source) => source.id)).toEqual(dossier.admitted)
		expect(dossier.admittedSources[0]).toEqual(EXAMPLE_RECORDS.sources[0])
	})
})

describe("buildDossier: operator outcomes", () => {
	test("reports blocker accuracy and time saved over the admitted dispositions", () => {
		expect(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }).outcomes).toEqual({
			dispositions: 1,
			pending: 0,
			pendingSources: [],
			blockerAccuracy: { status: "measured", held: 1, denominator: 1, sources: ["operator-log-2022"] },
			timeSaved: { status: "measured", minutes: 60, denominator: 1, sources: ["operator-log-2022"] },
		})
	})

	test("a disposition whose record is not yet available leaves both measures unknown", () => {
		expect(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-20" }).outcomes).toMatchObject({
			dispositions: 0,
			blockerAccuracy: { status: "unknown" },
			timeSaved: { status: "unknown" },
		})
	})
})

describe("buildDossier as of 2023-06-30", () => {
	test("admits the manager statement and resolves the occupied count", () => {
		const dossier = buildDossier(EXAMPLE_RECORDS, { asOf: "2023-06-30" })
		const house = dossier.buildings.find((section) => section.building.id === HOUSE)!

		expect(house.counts.occupied).toMatchObject({ status: "resolved", total: 18 })
	})
})

describe("one park point, real records", () => {
	const building = OPP_BUILDING

	describe("as of 2022-06-30, the pre-permit decision date", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2022-06-30" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("admits only the filing and the pavement plan. Excludes everything published later", () => {
			expect(dossier.admitted).toEqual(["dobnow-filing-b00520132-i1", "dob-bpp-3314476"])

			expect(dossier.excluded.map((record) => record.id)).toEqual([
				"dobnow-approval-b00520132-i1",
				"dobnow-first-permit-b00520132-i1",
				"pluto-26v2",
				"pad-geosearch-26c",
				"fcc-bdc-cable-j22",
				"fcc-bdc-fttp-j22",
				"fcc-bdc-fttp-d25",
			])
		})

		test("shows 375 planned units from the filing, with completed and occupied unresolved", () => {
			expect(section.counts.planned).toMatchObject({ status: "resolved", total: 375 })

			expect(section.counts.completed).toMatchObject({
				status: "unresolved",
				reason: expect.stringMatching(/no completed count/),
			})
		})

		test("names the developer and architect with signing authority unknown, and no provider or reading", () => {
			expect(section.authority.unknown.map((relation) => relation.organization)).toEqual([
				"JEMB Realty",
				"FXCollaborative Architects LLP",
			])

			expect(section.availability).toEqual([])
			expect(section.readings).toEqual([])

			expect(section.unresolved.map((item) => item.question)).toContainEqual(
				expect.stringMatching(/construction window.*no end/)
			)
		})

		test("has no position or membership, because Geosearch and PLUTO 26v2 became available later", () => {
			expect(section.position).toEqual({
				status: "unresolved",
				reason: "no position on 2022-06-30 for building:nyc-bin-3429422",
				conflicting: [],
			})

			expect(section.memberships).toEqual([])
		})
	})

	describe("as of 2023-06-30, with the first BDC vintage public", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2023-06-30" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("shows Charter cable at the block and Verizon not yet filed there", () => {
			expect(section.availability.map((entry) => [entry.provider, entry.answer.status])).toEqual([
				["Charter Communications (Spectrum)", "available"],
			])

			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-block:360470504012000",
				surveyedAt: "2022-06-30",
				class: "source_present_empty",
				sources: ["fcc-bdc-fttp-j22"],
			})

			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-tract:36047050401",
				surveyedAt: "2022-06-30",
				class: "records",
				sources: ["fcc-bdc-fttp-j22"],
			})
		})

		test("the completed count stays unresolved until PLUTO", () => {
			expect(section.counts.completed).toMatchObject({ status: "unresolved" })
		})
	})

	describe("as of 2026-10-05, retrieval day", () => {
		const dossier = buildDossier(OPP_RECORDS, { asOf: "2026-10-05" })
		const section = dossier.buildings.find((entry) => entry.building.id === building)!

		test("resolves the alias, the completed count and Verizon FTTP at the block", () => {
			expect(section.aliases).toEqual([
				{
					text: "11 Ocean Parkway, Brooklyn, NY 11218",
					resolution: {
						kind: "resolved",
						entity: building,
						evidence: { source: "pad-geosearch-26c", observedAt: null, validFrom: null, validTo: null },
					},
				},
			])

			expect(section.counts.completed).toMatchObject({ status: "resolved", total: 375 })

			expect(section.availability.map((entry) => [entry.provider, entry.answer.status])).toEqual([
				["Charter Communications (Spectrum)", "available"],
				["Verizon", "available"],
			])
		})

		test("places the building at the Geosearch point, inside the census block and tract PLUTO 26v2 names", () => {
			expect(section.position).toMatchObject({
				status: "resolved",
				latitude: 40.65017,
				longitude: -73.97264,
				synthetic: false,
			})

			expect(section.position.status === "resolved" && section.position.positions[0]!.evidence.source).toBe(
				"pad-geosearch-26c"
			)

			expect(section.memberships.map((membership) => [membership.extent, membership.evidence.source])).toEqual([
				["census-block:360470504012000", "pluto-26v2"],
				["census-tract:36047050401", "pluto-26v2"],
			])

			expect(dossier.unplaced).toEqual([])
		})

		test("the two FTTP vintages are separate surveys, never a conflict", () => {
			expect(section.readings).toContainEqual({
				layer: "fcc-bdc-fttp",
				extent: "census-block:360470504012000",
				surveyedAt: "2025-12-31",
				class: "records",
				sources: ["fcc-bdc-fttp-d25"],
			})

			expect(section.readings.every((reading) => reading.class !== "conflicting")).toBe(true)
		})
	})
})
