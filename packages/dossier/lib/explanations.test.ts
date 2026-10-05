/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import { buildDossier } from "#dossier"
import { CommercialEventKind } from "#events"
import {
	type AvailabilityCheck,
	type CheckResult,
	type Explanation,
	ExplanationKind,
	type ExplanationProbability,
	rankExplanations,
	type Statement,
	StatementKind,
} from "#explanations"
import type { SourceRecord } from "#sources"
import {
	ANNEX,
	AVAILABILITY,
	COMPLETED20,
	CONTAINMENT,
	EMPTY_RECORDS,
	ENTITIES,
	HOUSE,
	NORTH,
	SOURCES,
} from "#test/fixtures/example-house"
import { OPP_BUILDING, OPP_RECORDS } from "#test/fixtures/one-park-point"
import type { DossierRecords } from "#validate"

const CHECK: AvailabilityCheck = { id: "house-fiber", subject: HOUSE, layer: "fiber", extent: "cell-9" }

const STUDY: SourceRecord = {
	id: "outcome-study-2022",
	publisher: "Example Operator",
	title: "Exception outcome study",
	observedAt: "2022-01-10",
	availableAt: "2022-01-15",
}

const LATER_SURVEY: SourceRecord = {
	id: "survey-2023",
	publisher: "Example Surveyor",
	title: "Fiber survey",
	observedAt: "2023-03-15",
	availableAt: "2023-03-20",
}

const DECISION_LOG: SourceRecord = {
	id: "operator-log-2022-06",
	publisher: "Example Operator",
	title: "Investigation log, June",
	observedAt: "2022-06-01",
	availableAt: "2022-06-05",
}

const OUTCOME_LOG: SourceRecord = {
	id: "operator-log-2022-07",
	publisher: "Example Operator",
	title: "Investigation log, July",
	observedAt: "2022-07-08",
	availableAt: "2022-07-10",
}

const ALL_KINDS: readonly ExplanationKind[] = ["identity", "access", "capacity", "installation", "route"]

/**
 * A fiber reading at cell-9, the check's extent.
 *
 * No other fixture reads cell-9.
 * By default the source looked on 2022-03-15 and found no record.
 */
function fiberReading(overrides: Partial<LayerReading> = {}): LayerReading {
	return {
		layer: "fiber",
		extent: "cell-9",
		basis: "source_present",
		surveyedAt: "2022-03-15",
		records: 0,
		evidence: { source: "survey-2022" },
		...overrides,
	}
}

/**
 * Fiber records in the district around cell-9 on the same survey.
 */
const NEARBY = fiberReading({ extent: "district-9", records: 4 })

const OPEN_WINDOW = { subject: HOUSE, start: "2021-06-01", stage: "permit issued", evidence: { source: "permit-2021" } }

/**
 * The survey's statements that Example House lies in cell-9 and in district-9.
 */
const HOUSE_MEMBERSHIPS = [
	{ subject: HOUSE, extent: "cell-9", evidence: { source: "survey-2022" } },
	{ subject: HOUSE, extent: "district-9", evidence: { source: "survey-2022" } },
]

/**
 * Example House with its entrances, its memberships, the fiber check and the failing reading.
 *
 * Every explanation kind is checked against these records, and none has a supporting record.
 */
function recordsWith(overrides: Partial<DossierRecords> = {}): DossierRecords {
	return {
		...EMPTY_RECORDS,
		sources: [...SOURCES, STUDY, LATER_SURVEY, DECISION_LOG, OUTCOME_LOG],
		entities: ENTITIES,
		containment: CONTAINMENT,
		memberships: HOUSE_MEMBERSHIPS,
		readings: [fiberReading()],
		checks: [CHECK],
		...overrides,
	}
}

function checkResult(records: DossierRecords, asOf = "2022-06-30"): CheckResult {
	const section = buildDossier(records, { asOf }).buildings.find((entry) => entry.building.id === HOUSE)!

	return section.checks[0]!
}

function kindsOf(result: CheckResult): readonly ExplanationKind[] {
	return result.exception!.explanations.map((explanation) => explanation.kind)
}

function explanationOf(result: CheckResult, kind: ExplanationKind): Explanation {
	return result.exception!.explanations.find((explanation) => explanation.kind === kind)!
}

function fact(text: string, sources: readonly string[]): Statement {
	return { kind: StatementKind.Fact, text, sources }
}

function probability(kind: ExplanationKind, value: number): ExplanationProbability {
	return {
		check: CHECK.id,
		kind,
		probability: value,
		basis: `held in ${value * 10} of 10 comparable exceptions`,
		evidence: { source: STUDY.id },
	}
}

describe("explainCheck: identity, access, capacity, installation and route", () => {
	test("records that support no explanation produce zero explanations, and every kind is checked", () => {
		const result = checkResult(recordsWith())

		expect(result.status).toBe("source_present_empty")

		expect(result.exception).toMatchObject({
			vintage: "2022-03-15",
			checkedAt: "2022-03-15",
			class: "source_present_empty",
			explanations: [],
			unsupported: ALL_KINDS,
			ranking: { kind: "none" },
			resolution: [],
		})
	})

	test("identity: an alias of the building resolves to two entities", () => {
		const result = checkResult(
			recordsWith({
				aliases: [
					{
						text: "Example House",
						candidates: [
							{ entity: HOUSE, evidence: { source: "survey-2022" } },
							{ entity: ANNEX, evidence: { source: "permit-2021" } },
						],
					},
				],
			})
		)

		expect(kindsOf(result)).toEqual(["identity"])

		const identity = explanationOf(result, "identity")

		expect(identity.hypothesis).toEqual({
			kind: "hypothesis",
			text: "Example House may not be among the premises the fiber source keys at cell-9.",
			sources: [],
		})

		expect(identity.supporting).toEqual([
			fact('The alias "Example House" refers to 2 entities: building:example-house, building:example-annex.', [
				"survey-2022",
				"permit-2021",
			]),
		])

		expect(identity.missing).toEqual([
			"a record from the fiber source that names the premises it keys at cell-9, such as its location identifier for Example House",
		])
	})

	test("access: a landlord permission for an entrance is dated after the reading", () => {
		const result = checkResult(
			recordsWith({
				events: [
					{
						id: "p1",
						kind: CommercialEventKind.LandlordPermission,
						parties: [{ name: "Example Management Co", role: "manager" }],
						scope: [NORTH],
						date: "2022-05-10",
						evidence: { source: "survey-2022" },
					},
				],
			})
		)

		expect(kindsOf(result)).toEqual(["access"])

		expect(explanationOf(result, "access").supporting).toEqual([
			fact(
				"Landlord permission p1 from Example Management Co for entrance:example-house-north is dated 2022-05-10, after 2022-03-15.",
				["survey-2022"]
			),
		])
	})

	test("access: a permission in force on the reading's date covers one of the building's two entrances", () => {
		const result = checkResult(
			recordsWith({
				events: [
					{
						id: "p2",
						kind: CommercialEventKind.LandlordPermission,
						parties: [{ name: "Example Management Co", role: "manager" }],
						scope: [NORTH],
						date: "2022-03-01",
						evidence: { source: "survey-2022" },
					},
				],
			})
		)

		expect(kindsOf(result)).toEqual(["access"])

		expect(explanationOf(result, "access").supporting).toEqual([
			fact(
				"Landlord permission p2 from Example Management Co, dated 2022-03-01, covers entrance:example-house-north and not the whole of Example House.",
				["survey-2022"]
			),
		])
	})

	test("capacity: a source states that the serving element has no spare capacity", () => {
		const result = checkResult(
			recordsWith({
				blockers: [
					{
						id: "b1",
						subject: HOUSE,
						kind: ExplanationKind.Capacity,
						applies: true,
						statement: "Cabinet C-9 has no spare ports.",
						evidence: { source: "survey-2022" },
					},
				],
			})
		)

		expect(kindsOf(result)).toEqual(["capacity"])

		expect(explanationOf(result, "capacity").supporting).toEqual([
			fact('Observation b1 states a capacity blocker at Example House: "Cabinet C-9 has no spare ports".', [
				"survey-2022",
			]),
		])
	})

	test("installation: a construction window had not closed on the reading's date", () => {
		const result = checkResult(recordsWith({ windows: [OPEN_WINDOW] }))

		expect(kindsOf(result)).toEqual(["installation"])

		expect(explanationOf(result, "installation").supporting).toEqual([
			fact('The construction window "permit issued" opened 2021-06-01 and states no end.', ["permit-2021"]),
		])
	})

	test("route: the layer holds records at another extent on the same survey", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading(), NEARBY] }))

		expect(kindsOf(result)).toEqual(["route"])

		const route = explanationOf(result, "route")

		expect(route.hypothesis.text).toBe("The fiber network may not have reached cell-9 on 2022-03-15.")

		expect(route.supporting).toEqual([
			fact("The fiber reading over district-9 as of 2022-03-15 holds 4 records.", ["survey-2022"]),
		])
	})

	test("an open construction window and fiber records nearby support installation and route together", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading(), NEARBY], windows: [OPEN_WINDOW] }))

		expect(kindsOf(result)).toEqual(["installation", "route"])
		expect(result.exception!.unsupported).toEqual(["identity", "access", "capacity"])
	})

	test("route: records at an extent that no membership places the building in support nothing", () => {
		const result = checkResult(
			recordsWith({ readings: [fiberReading(), NEARBY], memberships: [HOUSE_MEMBERSHIPS[0]!] })
		)

		expect(result.exception!.explanations).toEqual([])
		expect(result.exception!.unsupported).toContain("route")
	})

	test("route: records supplied for another building support nothing", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading(), { ...NEARBY, subject: ANNEX }] }))

		expect(result.exception!.unsupported).toContain("route")
	})
})

describe("explainCheck: supporting, conflicting and missing records, and the investigation", () => {
	test("installation lists a completed count and another provider's availability on the reading's date as conflicting", () => {
		const result = checkResult(
			recordsWith({
				windows: [OPEN_WINDOW],
				counts: [{ ...COMPLETED20, at: "2022-03-01" }],
				availability: AVAILABILITY,
			})
		)

		const installation = explanationOf(result, "installation")

		expect(installation.conflicting).toEqual([
			fact("20 completed units are recorded for Example House on 2022-03-01.", ["inspection-2022"]),
			fact("Example Fiber 1 Gbps is recorded as available at Example House on 2022-03-15.", ["survey-2022"]),
		])

		expect(installation.missing).toEqual([
			"a completion or occupancy record for Example House dated on or before 2022-03-15",
		])
	})

	test("a construction window that closed before the reading conflicts with installation and supports nothing", () => {
		const result = checkResult(recordsWith({ windows: [{ ...OPEN_WINDOW, end: "2022-02-01" }] }))

		expect(result.exception!.explanations).toEqual([])
		expect(result.exception!.unsupported).toContain("installation")
	})

	test("route lists an earlier reading with records at the check's extent as conflicting", () => {
		const result = checkResult(
			recordsWith({ readings: [fiberReading({ surveyedAt: "2021-03-15", records: 2 }), fiberReading(), NEARBY] })
		)

		expect(result.exception!.vintage).toBe("2022-03-15")

		expect(explanationOf(result, "route").conflicting).toEqual([
			fact("The fiber reading over cell-9 as of 2021-03-15 holds 2 records.", ["survey-2022"]),
		])
	})

	test("a source's statement that a blocker does not apply conflicts with that explanation", () => {
		const result = checkResult(
			recordsWith({
				blockers: [
					{
						id: "b1",
						subject: HOUSE,
						kind: ExplanationKind.Capacity,
						applies: true,
						statement: "Cabinet C-9 has no spare ports",
						evidence: { source: "survey-2022" },
					},
					{
						id: "b2",
						subject: HOUSE,
						kind: ExplanationKind.Capacity,
						applies: false,
						statement: "Port 12 at cabinet C-9 is reserved for Example House",
						evidence: { source: "inspection-2022" },
					},
				],
			})
		)

		expect(explanationOf(result, "capacity").conflicting).toEqual([
			fact(
				'Observation b2 states no capacity blocker at Example House: "Port 12 at cabinet C-9 is reserved for Example House".',
				["inspection-2022"]
			),
		])
	})

	test("each explanation names an investigation and the next action if it holds and if it fails", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading(), NEARBY], windows: [OPEN_WINDOW] }))

		expect(explanationOf(result, "installation").investigation).toEqual({
			action: "Retrieve Example House's completion or occupancy record and compare its date with 2022-03-15.",
			ifHolds: "Repeat the check on the first fiber reading dated after Example House's completion.",
			ifFails: "Investigate route next.",
		})

		expect(explanationOf(result, "route").investigation).toEqual({
			action:
				"Obtain the provider's plant record for cell-9, or a surveyed reading of fiber over it, dated on or before 2022-03-15.",
			ifHolds: "Request the route and cost of extending the fiber network to cell-9.",
			ifFails: "Investigate installation next.",
		})
	})

	test("the only supported explanation names the unsupported kinds as the place to look next", () => {
		const result = checkResult(recordsWith({ windows: [OPEN_WINDOW] }))

		expect(explanationOf(result, "installation").investigation.ifFails).toBe(
			"No other explanation has a supporting record. Look for a record on identity, access, capacity and route."
		)
	})
})

describe("explainCheck: the absence rule", () => {
	test("a surveyed empty reading establishes absence at the check's extent and supports route", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading({ basis: "surveyed" })] }))

		const absence: Statement = {
			kind: "deduction",
			text: "A reading on a surveyed basis that holds no record supports exclusion, so the absence of fiber service at cell-9 on 2022-03-15 is established for the surveyed extent.",
			sources: ["survey-2022"],
		}

		expect(result.status).toBe("surveyed_empty")
		expect(result.answer).toContainEqual(absence)
		expect(kindsOf(result)).toEqual(["route"])
		expect(explanationOf(result, "route").supporting).toEqual([absence])
		expect(explanationOf(result, "route").missing).toEqual(["the provider's plant record for cell-9"])
	})

	test("a source_present empty reading leaves absence unknown and supports no explanation by itself", () => {
		const result = checkResult(recordsWith())

		expect(result.answer).toContainEqual({
			kind: "deduction",
			text: "A reading on a source_present basis that holds no record does not support exclusion, so the absence of fiber service at cell-9 on 2022-03-15 is unknown.",
			sources: ["survey-2022"],
		})

		expect(result.exception!.unsupported).toContain("route")
	})

	test("when route has other support, a source_present zero is missing evidence rather than support", () => {
		const route = explanationOf(checkResult(recordsWith({ readings: [fiberReading(), NEARBY] })), "route")

		expect(route.supporting.map((statement) => statement.text)).not.toContainEqual(
			expect.stringContaining("over cell-9")
		)

		expect(route.missing).toEqual([
			"a surveyed or designated reading of fiber over cell-9, because a zero on a source_present basis establishes no absence",
			"the provider's plant record for cell-9",
		])
	})

	test("a designated empty reading supports route as a surveyed one does", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading({ basis: "designated" })] }))

		expect(result.status).toBe("surveyed_empty")
		expect(kindsOf(result)).toEqual(["route"])
	})
})

describe("explainCheck: membership at the source's key", () => {
	test("a reading supplied for another building at the check's extent answers the check", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading({ subject: ANNEX, records: 3 })] }))

		expect(result.status).toBe("records")
		expect(result.exception).toBeUndefined()

		expect(result.answer).toEqual([
			fact("The fiber reading over cell-9 as of 2022-03-15 holds 3 records.", ["survey-2022"]),
			{
				kind: "deduction",
				text: "The fiber reading over cell-9 on 2022-03-15 holds records, so the check passes.",
				sources: ["survey-2022"],
			},
		])
	})

	test("a building without an availability record of its own passes when its extent holds records", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading({ records: 2 })], availability: [] }))

		expect(result.status).toBe("records")
		expect(result.exception).toBeUndefined()
	})

	test("a reading of the building at another extent does not answer the check", () => {
		const result = checkResult(recordsWith({ readings: [NEARBY] }))

		expect(result.status).toBe("unknown")

		expect(result.answer).toEqual([
			fact("No admitted reading of fiber covers cell-9.", []),
			{
				kind: "deduction",
				text: "Without a survey of cell-9, whether fiber service exists there on 2022-06-30 is unknown.",
				sources: [],
			},
		])

		expect(result.exception).toMatchObject({ checkedAt: "2022-06-30", class: "unknown" })
		expect(result.exception!.vintage).toBeUndefined()
	})
})

describe("explainCheck: a later reading that resolves the exception", () => {
	const records = recordsWith({
		readings: [
			fiberReading(),
			NEARBY,
			fiberReading({ surveyedAt: "2023-03-15", records: 5, evidence: { source: "survey-2023" } }),
		],
		windows: [OPEN_WINDOW],
	})

	test("the later reading resolves the exception without establishing an explanation", () => {
		const result = checkResult(records, "2023-06-30")

		expect(result).toMatchObject({ status: "records", vintage: "2023-03-15" })
		expect(result.exception).toMatchObject({ vintage: "2022-03-15", class: "source_present_empty" })
		expect(kindsOf(result)).toEqual(["installation", "route"])

		expect(result.exception!.resolution).toEqual([
			{
				kind: "deduction",
				text: "The fiber readings over cell-9 from 2023-03-15 hold records, so the check passes from 2023-03-15 and resolves the exception recorded on 2022-03-15. A reading dated 2023-03-15 does not establish whether any explanation held on 2022-03-15.",
				sources: ["survey-2023"],
			},
		])
	})

	test("before the later reading is available the exception is open", () => {
		const result = checkResult(records, "2022-06-30")

		expect(result.status).toBe("source_present_empty")
		expect(result.exception!.resolution).toEqual([])
	})
})

describe("explainCheck: statement kinds", () => {
	const result = checkResult(
		recordsWith({
			readings: [fiberReading(), NEARBY],
			windows: [OPEN_WINDOW],
			counts: [{ ...COMPLETED20, at: "2022-03-01" }],
			probabilities: [probability("installation", 0.3)],
			dispositions: [
				{
					id: "d1",
					check: CHECK.id,
					investigated: ExplanationKind.Installation,
					decision: "Request the certificate of occupancy",
					decidedAt: "2022-06-01",
					evidence: { source: DECISION_LOG.id },
				},
			],
		})
	)

	const exception = result.exception!

	test("every statement carries one of the five kinds", () => {
		const statements = [
			...result.answer,
			...exception.facts,
			...exception.deductions,
			...exception.estimates,
			...result.decisions,
			...exception.explanations.flatMap((explanation) => [
				explanation.hypothesis,
				...explanation.supporting,
				...explanation.conflicting,
			]),
		]

		expect(statements.length).toBeGreaterThan(0)

		for (const statement of statements) {
			expect(Object.values(StatementKind)).toContain(statement.kind)
		}
	})

	test("each list holds only its kinds, and a hypothesis is never a fact", () => {
		expect(exception.facts.map((statement) => statement.kind)).toEqual(["fact"])
		expect(exception.deductions.map((statement) => statement.kind)).toEqual(["deduction"])
		expect(exception.estimates.map((statement) => statement.kind)).toEqual(["estimate"])
		expect(result.decisions.map((statement) => statement.kind)).toEqual(["decision"])

		for (const explanation of exception.explanations) {
			expect(explanation.hypothesis.kind).toBe("hypothesis")
			expect(explanation.hypothesis.text).toMatch(/ may /)

			for (const statement of [...explanation.supporting, ...explanation.conflicting]) {
				expect(["fact", "deduction"]).toContain(statement.kind)
				expect(statement.text).not.toMatch(/ may /)
			}
		}
	})

	test("an estimate states the documented probability and cites its record", () => {
		expect(exception.estimates).toEqual([
			{
				kind: "estimate",
				text: "The probability that the installation explanation holds is 0.3 (held in 3 of 10 comparable exceptions).",
				sources: ["outcome-study-2022"],
			},
		])
	})
})

describe("rankExplanations", () => {
	test("ranks by documented probability, highest first, when every compared explanation has one", () => {
		expect(
			rankExplanations(["installation", "route"], [probability("installation", 0.3), probability("route", 0.6)])
		).toEqual({
			kind: "ranked",
			order: [
				{ explanation: "route", probability: 0.6 },
				{ explanation: "installation", probability: 0.3 },
			],
		})
	})

	test("shows scenarios when an explanation lacks a documented probability", () => {
		expect(rankExplanations(["installation", "route"], [probability("installation", 0.3)])).toEqual({
			kind: "scenarios",
			undocumented: ["route"],
		})
	})

	test("treats two probabilities that disagree for one explanation as undocumented", () => {
		expect(
			rankExplanations(
				["route"],
				[probability("route", 0.6), { ...probability("route", 0.4), basis: "a second study" }]
			)
		).toEqual({ kind: "scenarios", undocumented: ["route"] })
	})

	test("has nothing to rank when no explanation has a supporting record", () => {
		expect(rankExplanations([], [probability("route", 0.6)])).toEqual({ kind: "none" })
	})

	test("a dossier orders its explanations by the ranking and lists every documented probability as an estimate", () => {
		const result = checkResult(
			recordsWith({
				readings: [fiberReading(), NEARBY],
				windows: [OPEN_WINDOW],
				probabilities: [probability("installation", 0.3), probability("route", 0.6), probability("capacity", 0.1)],
			})
		)

		expect(result.exception!.ranking).toEqual({
			kind: "ranked",
			order: [
				{ explanation: "route", probability: 0.6 },
				{ explanation: "installation", probability: 0.3 },
			],
		})

		expect(kindsOf(result)).toEqual(["route", "installation"])

		expect(result.exception!.estimates.map((statement) => statement.sources)).toEqual([
			[STUDY.id],
			[STUDY.id],
			[STUDY.id],
		])
	})

	test("without documented probabilities a dossier shows scenarios for every supported explanation", () => {
		const result = checkResult(recordsWith({ readings: [fiberReading(), NEARBY], windows: [OPEN_WINDOW] }))

		expect(result.exception!.ranking).toEqual({ kind: "scenarios", undocumented: ["installation", "route"] })

		for (const explanation of result.exception!.explanations) {
			expect(explanation.investigation.ifHolds.length).toBeGreaterThan(0)
			expect(explanation.investigation.ifFails.length).toBeGreaterThan(0)
		}
	})
})

describe("explainCheck: decisions and outcomes", () => {
	const records = recordsWith({
		windows: [OPEN_WINDOW],
		dispositions: [
			{
				id: "d1",
				check: CHECK.id,
				investigated: ExplanationKind.Installation,
				decision: "Request the certificate of occupancy.",
				decidedAt: "2022-06-01",
				evidence: { source: DECISION_LOG.id },
				outcome: {
					held: false,
					at: "2022-07-08",
					minutesSpent: 45,
					baselineMinutes: 120,
					evidence: { source: OUTCOME_LOG.id },
				},
			},
		],
	})

	const decision: Statement = {
		kind: "decision",
		text: 'On 2022-06-01 the operator decided to investigate installation: "Request the certificate of occupancy".',
		sources: [DECISION_LOG.id],
	}

	test("a disposition is a decision, and its outcome waits for the outcome's own record", () => {
		expect(checkResult(records, "2022-06-30").decisions).toEqual([decision])
	})

	test("once the outcome's record is admitted, the outcome is a fact", () => {
		expect(checkResult(records, "2022-07-31").decisions).toEqual([
			decision,
			fact("On 2022-07-08 the operator recorded that the installation explanation did not hold.", [OUTCOME_LOG.id]),
		])
	})
})

describe("one park point, the fiber check at its census block", () => {
	function oppCheck(asOf: string): CheckResult {
		return buildDossier(OPP_RECORDS, { asOf }).buildings.find((entry) => entry.building.id === OPP_BUILDING)!.checks[0]!
	}

	describe("as of 2023-06-30, with the first BDC vintage public", () => {
		const result = oppCheck("2023-06-30")
		const exception = result.exception!

		test("the zero at the block leaves fiber unknown, and the exception is open", () => {
			expect(result.status).toBe("source_present_empty")

			expect(result.answer).toEqual([
				fact(
					"The fcc-bdc-fttp reading over census-block:360470504012000 as of 2022-06-30 holds 0 records on a source_present basis.",
					["fcc-bdc-fttp-j22"]
				),
				{
					kind: "deduction",
					text: "A reading on a source_present basis that holds no record does not support exclusion, so the absence of fcc-bdc-fttp service at census-block:360470504012000 on 2022-06-30 is unknown.",
					sources: ["fcc-bdc-fttp-j22"],
				},
			])

			expect(exception).toMatchObject({ vintage: "2022-06-30", checkedAt: "2022-06-30", resolution: [] })
		})

		test("installation and route compete, and identity, access and capacity have no supporting record", () => {
			expect(kindsOf(result)).toEqual(["installation", "route"])
			expect(exception.unsupported).toEqual(["identity", "access", "capacity"])
			expect(exception.ranking).toEqual({ kind: "scenarios", undocumented: ["installation", "route"] })
		})

		test("installation rests on the open filing window and the later first permit, against Charter's cable record", () => {
			const installation = explanationOf(result, "installation")

			expect(installation.hypothesis.text).toBe(
				"11 Ocean Parkway may not have been ready to receive service on 2022-06-30."
			)

			expect(installation.supporting).toEqual([
				fact(
					'The construction window "new building filed, standard plan examination" opened 2021-09-16 and states no end.',
					["dobnow-filing-b00520132-i1"]
				),
				fact('The construction window "first permit issued" opened 2022-11-15, after 2022-06-30.', [
					"dobnow-first-permit-b00520132-i1",
				]),
			])

			expect(installation.conflicting).toEqual([
				fact(
					"Charter Communications (Spectrum) cable 1000/35 Mbps (census block, business) is recorded as available at 11 Ocean Parkway on 2022-06-30.",
					["fcc-bdc-cable-j22"]
				),
			])
		})

		test("route rests on the 70 fiber rows in the tract and names the block-level record it lacks", () => {
			const route = explanationOf(result, "route")

			expect(route.hypothesis.text).toBe(
				"The fcc-bdc-fttp network may not have reached census-block:360470504012000 on 2022-06-30."
			)

			expect(route.supporting).toEqual([
				fact("The fcc-bdc-fttp reading over census-tract:36047050401 as of 2022-06-30 holds 70 records.", [
					"fcc-bdc-fttp-j22",
				]),
			])

			expect(route.conflicting).toEqual([])

			expect(route.missing).toEqual([
				"a surveyed or designated reading of fcc-bdc-fttp over census-block:360470504012000, because a zero on a source_present basis establishes no absence",
				"the provider's plant record for census-block:360470504012000",
			])
		})
	})

	describe("as of 2026-10-05, with the 2025-12-31 vintage public", () => {
		const result = oppCheck("2026-10-05")

		test("six fiber rows at the block pass the check", () => {
			expect(result).toMatchObject({ status: "records", vintage: "2025-12-31" })

			expect(result.answer[0]).toEqual(
				fact("The fcc-bdc-fttp reading over census-block:360470504012000 as of 2025-12-31 holds 6 records.", [
					"fcc-bdc-fttp-d25",
				])
			)
		})

		test("the 2025-12-31 reading resolves the 2022-06-30 exception and leaves its explanations hypotheses", () => {
			expect(result.exception).toMatchObject({ vintage: "2022-06-30", class: "source_present_empty" })
			expect(kindsOf(result)).toEqual(["installation", "route"])

			expect(result.exception!.resolution).toEqual([
				{
					kind: "deduction",
					text: "The fcc-bdc-fttp readings over census-block:360470504012000 from 2025-12-31 hold records, so the check passes from 2025-12-31 and resolves the exception recorded on 2022-06-30. A reading dated 2025-12-31 does not establish whether any explanation held on 2022-06-30.",
					sources: ["fcc-bdc-fttp-d25"],
				},
			])

			for (const explanation of result.exception!.explanations) {
				expect(explanation.hypothesis.kind).toBe("hypothesis")
			}

			expect(result.decisions).toEqual([])
		})
	})
})
