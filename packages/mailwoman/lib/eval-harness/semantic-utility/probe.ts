/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Define and audit the frozen semantic-utility probe.
 *   The pre-registration pins targets, controls, comparator, metrics, baseline, and thresholds.
 *   It grades assembled POI answers and records distinct POI outcome shapes.
 *   Both same-category and adjacent-category controls are required.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import {
	type CaseGrade,
	gradeCase,
	type POIBoardExpect,
	type POIBoardFixture,
	type POIBoardOutcome,
} from "#eval-harness/poi/board"
import {
	canonicalJSON,
	definitionContentHash,
	duplicateRowIDProblems,
	loadFrozenDefinition,
	preregistrationPath,
} from "#eval-harness/preregistration"

/**
 * Outcome shapes derived from `PipelineResult.path` and `POIIntentOutcome.type`.
 *
 * - `no_poi_branch` — the coordinator never took the POI branch, so there is no POI outcome at all.
 *   This is the measured baseline shape for every target row: an activity phrase scores `0`
 *   against the phrase lexicon, so the input is answered as an address parse of a sentence.
 * - `poi_abstain` — the branch was taken and declined.
 *   The reason travels beside the shape.
 * - `poi_intent_no_results` — the branch was taken, an intent was formed,
 *   and the executor returned nothing.
 * - `poi_intent_results` — the branch was taken and at least one row came back.
 *   The only shape the primary metric can grade, since the comparator reads the top result.
 */
export const POI_OUTCOME_SHAPES = [
	"no_poi_branch",
	"poi_abstain",
	"poi_intent_no_results",
	"poi_intent_results",
] as const

export type POIOutcomeShape = (typeof POI_OUTCOME_SHAPES)[number]

/**
 * Classify the POI outcome shape from a pipeline result.
 */
export function poiOutcomeShape(outcome: POIBoardOutcome): POIOutcomeShape {
	if (outcome.path !== "poi" || !outcome.poiIntent) return "no_poi_branch"

	if (outcome.poiIntent.type === "abstain") return "poi_abstain"

	return outcome.poiIntent.results?.length ? "poi_intent_results" : "poi_intent_no_results"
}

/**
 * Registered comparators; additions require a reviewed instrument.
 */
export const PROBE_COMPARATORS = ["poi_board_assembled_answer"] as const

export type ProbeComparatorName = (typeof PROBE_COMPARATORS)[number]

/**
 * Grade one row with a registered comparator; reject unknown names.
 */
export function gradeWithComparator(
	comparator: ProbeComparatorName,
	fixture: POIBoardFixture,
	outcome: POIBoardOutcome
): CaseGrade {
	if (comparator !== "poi_board_assembled_answer") {
		throw new Error(`semantic-utility probe: unregistered outcome comparator ${stringifyJSON(comparator)}`)
	}

	return gradeCase(fixture, outcome)
}

/**
 * Decisions admitted by the parent program.
 */
export const PROBE_DECISIONS = ["GO", "DIAGNOSTIC-ONLY", "STOP-REDESIGN"] as const

export type ProbeDecision = (typeof PROBE_DECISIONS)[number]

/**
 * Frozen target fixture with query provenance, anchor, and baseline limitations.
 */
export interface ProbeTargetRow extends POIBoardFixture {
	/**
	 * Source attesting the query form.
	 */
	attestedIn: string
	/**
	 * The committed board row this row's anchor and expectation are copied from, byte-for-byte.
	 */
	anchorFrom: string
	/**
	 * The activity phrase that replaces the venue noun.
	 * The only thing that varies against `anchorFrom`.
	 */
	activityPhrase: string
	/**
	 * The measured baseline shape for this row.
	 */
	baselineShape: POIOutcomeShape
	/**
	 * What information the baseline inputs do not carry, stated for this row.
	 */
	missingDistinction: string
}

/**
 * Both registered control groups are required.
 */
export const PROBE_CONTROL_GROUPS = ["same_category", "adjacent"] as const

export type ProbeControlGroup = (typeof PROBE_CONTROL_GROUPS)[number]

/**
 * One frozen control row, referenced BY ID into a committed fixture file and carried here with its
 * committed contents so {@linkcode resolveControlRows} can refuse a reference that has drifted.
 */
export interface ProbeControlRow {
	id: string
	group: ProbeControlGroup
	/**
	 * The committed fixture file the row lives in.
	 */
	source: string
	query: string
	locale?: string
	expect: POIBoardExpect
	/**
	 * The grade the row holds at baseline, and the grade it must still hold.
	 *
	 * `controlRegressionTolerance` is the number of rows allowed to move off this.
	 */
	expectedGrade: "pass"
	/**
	 * The failure this row would catch.
	 */
	guards: string
}

/**
 * One metric's arithmetic, written out so a reader never has to infer a denominator.
 */
export interface ProbeMetric {
	id: string
	numerator: string
	denominator: number
	aggregation: string
}

/**
 * The frozen decision thresholds.
 *
 * Numbers rather than adjectives, and all of them `>=` bars over stated denominators.
 */
export interface ProbeThresholds {
	/**
	 * GO — the primary numerator must reach this absolute count out of the primary denominator.
	 */
	minimumPrimaryNumerator: number
	/**
	 * GO — and it must gain at least this many rows over the frozen baseline.
	 *
	 * Stated as well as the absolute bar because a baseline that is not zero would make
	 * the absolute bar reachable without the observation moving anything.
	 */
	minimumPrimaryDelta: number
	/**
	 * Diagnostic-only — the routing numerator must reach this absolute count
	 * out of the diagnostic denominator.
	 */
	minimumDiagnosticNumerator: number
	/**
	 * Diagnostic-only — and gain at least this many rows over the frozen baseline.
	 */
	minimumDiagnosticDelta: number
	/**
	 * How many control rows may move off `expectedGrade`.
	 *
	 * Zero: a control regression is a stop under both decisions.
	 */
	controlRegressionTolerance: number
}

/**
 * The frozen baseline, measured against the pipeline before any semantic observation
 * existed. #1930 compares the post-injection run against exactly these numbers.
 */
export interface ProbeBaseline {
	measuredAt: string
	gitCommit: string
	primaryNumerator: number
	diagnosticNumerator: number
	controlHoldNumerator: number
	receipt: string
	/**
	 * What the numbers were measured against, in words.
	 *
	 * The tree state and anything about the run a bare sha does not carry.
	 */
	note: string
}

/**
 * The whole pre-registration, as committed.
 */
export interface SemanticProbeDefinition {
	probeID: string
	version: string
	issue: string
	route: string
	routeReason: string
	failureClass: string
	semanticObservation: string
	missingDistinction: string
	baselineFailureShape: POIOutcomeShape
	baselineFailureShapeNote: string
	outcomeComparator: ProbeComparatorName
	outcomeComparatorNote: string
	targetRows: ProbeTargetRow[]
	targetRowsNote: string
	controlRows: ProbeControlRow[]
	primaryMetric: ProbeMetric
	diagnosticMetric: ProbeMetric
	controlMetric: ProbeMetric
	thresholds: ProbeThresholds
	thresholdsNote: string
	baseline: ProbeBaseline
	decisionRule: string[]
}

/**
 * The freeze record: the definition's identity and the content hash that pins it.
 */
export interface ProbeFreezeRecord {
	definition: string
	probeID: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

/**
 * The committed pre-registration.
 */
export const PROBE_DEFINITION_PATH = preregistrationPath("semantic-utility", "probe-definition.json")

/**
 * The committed freeze record for it.
 */
export const PROBE_FREEZE_PATH = preregistrationPath("semantic-utility", "probe-freeze.json")

/**
 * The committed baseline receipt — the pre-injection measurement the #1930 decision compares against.
 */
export const PROBE_BASELINE_RECEIPT_PATH = preregistrationPath("semantic-utility", "baseline-receipt.json")

export { canonicalJSON } from "#eval-harness/preregistration"

/**
 * The content hash of one definition.
 */
export function probeDefinitionHash(definition: SemanticProbeDefinition): string {
	return definitionContentHash(definition)
}

/**
 * Everything that must be true of a definition, checked without running anything.
 *
 * One message per problem, each naming the field or row id.
 * Empty means the definition is executable.
 */
export function auditProbeDefinition(definition: SemanticProbeDefinition): string[] {
	const problems: string[] = []

	if (!(PROBE_COMPARATORS as readonly string[]).includes(definition.outcomeComparator)) {
		problems.push(`outcomeComparator ${stringifyJSON(definition.outcomeComparator)} is not registered`)
	}

	if (!(POI_OUTCOME_SHAPES as readonly string[]).includes(definition.baselineFailureShape)) {
		problems.push(`baselineFailureShape ${stringifyJSON(definition.baselineFailureShape)} is not a POI outcome shape`)
	}

	if (!definition.targetRows.length) {
		problems.push("targetRows is empty — a probe with no target measures nothing")
	}

	if (!definition.controlRows.length) {
		problems.push("controlRows is empty — an uncontrolled delta is a claim about nothing")
	}

	problems.push(...duplicateRowIDProblems([...definition.targetRows, ...definition.controlRows]))

	for (const row of definition.targetRows) {
		if (row.expect.kind !== "results") {
			problems.push(
				`target row ${row.id}: expect.kind is ${row.expect.kind}, but the primary metric grades an assembled answer`
			)
		}

		if (!(POI_OUTCOME_SHAPES as readonly string[]).includes(row.baselineShape)) {
			problems.push(
				`target row ${row.id}: baselineShape ${stringifyJSON(row.baselineShape)} is not a POI outcome shape`
			)
		}

		if (!row.missingDistinction.trim()) {
			problems.push(`target row ${row.id}: missingDistinction is blank`)
		}
	}

	for (const row of definition.controlRows) {
		if (!(PROBE_CONTROL_GROUPS as readonly string[]).includes(row.group)) {
			problems.push(`control row ${row.id}: group ${stringifyJSON(row.group)} is not a control group`)
		}

		if (!row.guards.trim()) {
			problems.push(`control row ${row.id}: guards is blank`)
		}
	}

	for (const group of PROBE_CONTROL_GROUPS) {
		if (!definition.controlRows.some((row) => row.group === group)) {
			problems.push(
				`control group ${stringifyJSON(group)} has no rows — see the module header for why one group alone is vacuous`
			)
		}
	}

	problems.push(...auditDenominators(definition))
	problems.push(...auditThresholds(definition))

	return problems
}

function auditDenominators(definition: SemanticProbeDefinition): string[] {
	const problems: string[] = []
	const targets = definition.targetRows.length
	const controls = definition.controlRows.length

	if (definition.primaryMetric.denominator !== targets) {
		problems.push(
			`primaryMetric.denominator ${definition.primaryMetric.denominator} !== ${targets} registered target rows`
		)
	}

	if (definition.diagnosticMetric.denominator !== targets) {
		problems.push(
			`diagnosticMetric.denominator ${definition.diagnosticMetric.denominator} !== ${targets} registered target rows`
		)
	}

	if (definition.controlMetric.denominator !== controls) {
		problems.push(
			`controlMetric.denominator ${definition.controlMetric.denominator} !== ${controls} registered control rows`
		)
	}

	return problems
}

function auditThresholds(definition: SemanticProbeDefinition): string[] {
	const problems: string[] = []
	const thresholds = definition.thresholds

	for (const [key, value] of Object.entries(thresholds)) {
		if (!Number.isInteger(value) || value < 0) {
			problems.push(`thresholds.${key} is ${stringifyJSON(value)} — every threshold is a whole row count`)
		}
	}

	if (thresholds.minimumPrimaryNumerator > definition.primaryMetric.denominator) {
		problems.push(
			`thresholds.minimumPrimaryNumerator ${thresholds.minimumPrimaryNumerator} exceeds the primary denominator ${definition.primaryMetric.denominator} — an unreachable bar can only ever record STOP-REDESIGN`
		)
	}

	if (thresholds.minimumDiagnosticNumerator > definition.diagnosticMetric.denominator) {
		problems.push(
			`thresholds.minimumDiagnosticNumerator ${thresholds.minimumDiagnosticNumerator} exceeds the diagnostic denominator ${definition.diagnosticMetric.denominator}`
		)
	}

	if (thresholds.controlRegressionTolerance >= definition.controlMetric.denominator) {
		problems.push(
			`thresholds.controlRegressionTolerance ${thresholds.controlRegressionTolerance} allows every control row to move — the control set would decide nothing`
		)
	}

	return problems
}

/**
 * Load the frozen pre-registration, refusing anything that would let the ruler move.
 *
 * Three refusals, in order: the freeze record must name this definition and version,
 * the definition's content hash must equal the frozen hash, and the audit must be clean.
 * A caller never receives a definition it may only partly trust.
 */
export async function loadProbeDefinition(
	definitionPath: PathBuilderLike = PROBE_DEFINITION_PATH,
	freezePath: PathBuilderLike = PROBE_FREEZE_PATH
): Promise<SemanticProbeDefinition> {
	return loadFrozenDefinition({
		definitionPath,
		freezePath,
		label: "semantic-utility probe",
		idField: "probeID",
		audit: auditProbeDefinition,
	})
}

/**
 * Resolve frozen control references and reject missing or changed fixtures.
 */
export function resolveControlRows(
	definition: SemanticProbeDefinition,
	committed: readonly POIBoardFixture[]
): POIBoardFixture[] {
	const byID = new Map(committed.map((fixture) => [fixture.id, fixture]))
	const resolved: POIBoardFixture[] = []

	for (const row of definition.controlRows) {
		const fixture = byID.get(row.id)

		if (!fixture) {
			throw new Error(`semantic-utility probe: control row ${stringifyJSON(row.id)} is not in ${row.source}`)
		}

		const declared = canonicalJSON({ id: row.id, query: row.query, locale: row.locale, expect: row.expect })

		const actual = canonicalJSON({
			id: fixture.id,
			query: fixture.query,
			locale: fixture.locale,
			expect: fixture.expect,
		})

		if (declared !== actual) {
			throw new Error(
				`semantic-utility probe: control row ${stringifyJSON(row.id)} has moved in ${row.source}\n  frozen : ${declared}\n  committed: ${actual}`
			)
		}

		resolved.push(fixture)
	}

	return resolved
}

/**
 * One row's measured outcome, target or control.
 */
export interface ProbeRowOutcome {
	id: string
	role: "target" | "control"
	group?: ProbeControlGroup
	query: string
	shape: POIOutcomeShape
	abstainReason?: string
	grade: CaseGrade
}

/**
 * The three counts a decision reads.
 */
export interface ProbeCounts {
	primaryNumerator: number
	primaryDenominator: number
	diagnosticNumerator: number
	diagnosticDenominator: number
	controlHoldNumerator: number
	controlDenominator: number
}

/**
 * Count a run using registered row counts as denominators.
 */
export function computeProbeCounts(
	definition: SemanticProbeDefinition,
	outcomes: readonly ProbeRowOutcome[]
): ProbeCounts {
	const targets = outcomes.filter((outcome) => outcome.role === "target")
	const controls = outcomes.filter((outcome) => outcome.role === "control")

	return {
		primaryNumerator: targets.filter((outcome) => outcome.grade.pass).length,
		primaryDenominator: definition.primaryMetric.denominator,
		diagnosticNumerator: targets.filter((outcome) => outcome.shape !== "no_poi_branch").length,
		diagnosticDenominator: definition.diagnosticMetric.denominator,
		controlHoldNumerator: controls.filter((outcome) => outcome.grade.pass).length,
		controlDenominator: definition.controlMetric.denominator,
	}
}

/**
 * One decision with the arithmetic that produced it.
 */
export interface ProbeVerdict {
	decision: ProbeDecision
	counts: ProbeCounts
	primaryDelta: number
	diagnosticDelta: number
	controlRegressions: number
	reasons: string[]
}

/**
 * Apply frozen thresholds in order: controls, GO, diagnostic-only, then stop.
 */
export function decideProbe(definition: SemanticProbeDefinition, counts: ProbeCounts): ProbeVerdict {
	const thresholds = definition.thresholds
	const baseline = definition.baseline
	const primaryDelta = counts.primaryNumerator - baseline.primaryNumerator
	const diagnosticDelta = counts.diagnosticNumerator - baseline.diagnosticNumerator
	const controlRegressions = baseline.controlHoldNumerator - counts.controlHoldNumerator

	const reasons: string[] = [
		`primary ${counts.primaryNumerator}/${counts.primaryDenominator} (baseline ${baseline.primaryNumerator}, delta ${primaryDelta >= 0 ? "+" : ""}${primaryDelta}; bars ${thresholds.minimumPrimaryNumerator} and +${thresholds.minimumPrimaryDelta})`,
		`diagnostic ${counts.diagnosticNumerator}/${counts.diagnosticDenominator} (baseline ${baseline.diagnosticNumerator}, delta ${diagnosticDelta >= 0 ? "+" : ""}${diagnosticDelta}; bars ${thresholds.minimumDiagnosticNumerator} and +${thresholds.minimumDiagnosticDelta})`,
		`control ${counts.controlHoldNumerator}/${counts.controlDenominator} (baseline ${baseline.controlHoldNumerator}, regressions ${controlRegressions}; tolerance ${thresholds.controlRegressionTolerance})`,
	]

	if (controlRegressions > thresholds.controlRegressionTolerance) {
		return {
			decision: "STOP-REDESIGN",
			counts,
			primaryDelta,
			diagnosticDelta,
			controlRegressions,
			reasons: [...reasons, "control regressions exceed tolerance"],
		}
	}

	const goHolds =
		counts.primaryNumerator >= thresholds.minimumPrimaryNumerator && primaryDelta >= thresholds.minimumPrimaryDelta

	if (goHolds) {
		return { decision: "GO", counts, primaryDelta, diagnosticDelta, controlRegressions, reasons }
	}

	const diagnosticHolds =
		counts.diagnosticNumerator >= thresholds.minimumDiagnosticNumerator &&
		diagnosticDelta >= thresholds.minimumDiagnosticDelta

	if (diagnosticHolds) {
		return { decision: "DIAGNOSTIC-ONLY", counts, primaryDelta, diagnosticDelta, controlRegressions, reasons }
	}

	return {
		decision: "STOP-REDESIGN",
		counts,
		primaryDelta,
		diagnosticDelta,
		controlRegressions,
		reasons: [...reasons, "neither the primary nor the diagnostic bar was reached"],
	}
}
