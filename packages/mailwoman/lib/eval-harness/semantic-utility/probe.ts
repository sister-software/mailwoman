/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines, audits, and decides the frozen semantic-utility probe.
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
 * - `no_poi_branch`: the coordinator did not take the POI branch.
 * - `poi_abstain`: the POI branch declined.
 *   The abstain reason is recorded beside the shape.
 * - `poi_intent_no_results`: the POI branch formed an intent and the executor returned no row.
 * - `poi_intent_results`: the executor returned at least one row.
 *   Only this shape can pass the primary metric, because the comparator reads the top result.
 */
export const POI_OUTCOME_SHAPES = [
	"no_poi_branch",
	"poi_abstain",
	"poi_intent_no_results",
	"poi_intent_results",
] as const

/**
 * One POI outcome shape.
 */
export type POIOutcomeShape = (typeof POI_OUTCOME_SHAPES)[number]

/**
 * Classifies the POI outcome shape of a pipeline result.
 */
export function poiOutcomeShape(outcome: POIBoardOutcome): POIOutcomeShape {
	if (outcome.path !== "poi" || !outcome.poiIntent) return "no_poi_branch"

	if (outcome.poiIntent.type === "abstain") return "poi_abstain"

	return outcome.poiIntent.results?.length ? "poi_intent_results" : "poi_intent_no_results"
}

/**
 * The registered outcome comparators.
 */
export const PROBE_COMPARATORS = ["poi_board_assembled_answer"] as const

/**
 * One registered comparator name.
 */
export type ProbeComparatorName = (typeof PROBE_COMPARATORS)[number]

/**
 * Grades one row with a registered comparator.
 * It throws for an unregistered name.
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
 * The decisions the probe can record.
 */
export const PROBE_DECISIONS = ["GO", "DIAGNOSTIC-ONLY", "STOP-REDESIGN"] as const

/**
 * One probe decision.
 */
export type ProbeDecision = (typeof PROBE_DECISIONS)[number]

/**
 * A frozen target row with its query provenance and baseline shape.
 */
export interface ProbeTargetRow extends POIBoardFixture {
	/**
	 * The source that attests the query form.
	 */
	attestedIn: string
	/**
	 * The committed board row whose anchor and expectation this row copies exactly.
	 */
	anchorFrom: string
	/**
	 * The activity phrase that replaces the venue noun.
	 * It is the only difference from `anchorFrom`.
	 */
	activityPhrase: string
	/**
	 * The measured baseline shape for this row.
	 */
	baselineShape: POIOutcomeShape
	/**
	 * The information this row's baseline inputs lack.
	 */
	missingDistinction: string
}

/**
 * The registered control groups.
 * The audit requires at least one row in each.
 */
export const PROBE_CONTROL_GROUPS = ["same_category", "adjacent"] as const

/**
 * One control group.
 */
export type ProbeControlGroup = (typeof PROBE_CONTROL_GROUPS)[number]

/**
 * A frozen control row that refers by ID to a row in a committed fixture file.
 *
 * The row repeats the fixture's contents so {@linkcode resolveControlRows} can
 * detect a fixture that has changed.
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
	 * The grade the row holds at baseline and must keep.
	 *
	 * `controlRegressionTolerance` limits how many rows may lose it.
	 */
	expectedGrade: "pass"
	/**
	 * The failure this row would catch.
	 */
	guards: string
}

/**
 * One metric's numerator, denominator, and aggregation, stated explicitly.
 */
export interface ProbeMetric {
	id: string
	numerator: string
	denominator: number
	aggregation: string
}

/**
 * The frozen decision thresholds.
 * Each one is a whole row count.
 */
export interface ProbeThresholds {
	/**
	 * The minimum primary numerator for GO.
	 */
	minimumPrimaryNumerator: number
	/**
	 * How many rows the primary numerator must gain over the frozen baseline for GO.
	 *
	 * The delta bar is needed because a nonzero baseline could meet the absolute bar with no change.
	 */
	minimumPrimaryDelta: number
	/**
	 * The minimum diagnostic (routing) numerator for DIAGNOSTIC-ONLY.
	 */
	minimumDiagnosticNumerator: number
	/**
	 * How many rows the diagnostic numerator must gain over the frozen baseline for DIAGNOSTIC-ONLY.
	 */
	minimumDiagnosticDelta: number
	/**
	 * The number of control rows that may lose `expectedGrade` before the decision becomes STOP-REDESIGN.
	 */
	controlRegressionTolerance: number
}

/**
 * The frozen baseline counts, measured before the semantic observation was added.
 */
export interface ProbeBaseline {
	measuredAt: string
	gitCommit: string
	primaryNumerator: number
	diagnosticNumerator: number
	controlHoldNumerator: number
	receipt: string
	/**
	 * A prose description of the tree state and run conditions that the commit hash does not capture.
	 */
	note: string
}

/**
 * The committed pre-registration.
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
 * The probe's freeze record, holding the definition's identity and content hash.
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
 * Path to the committed pre-registration.
 */
export const PROBE_DEFINITION_PATH = preregistrationPath("semantic-utility", "probe-definition.json")

/**
 * Path to the committed freeze record.
 */
export const PROBE_FREEZE_PATH = preregistrationPath("semantic-utility", "probe-freeze.json")

/**
 * Path to the committed baseline receipt.
 */
export const PROBE_BASELINE_RECEIPT_PATH = preregistrationPath("semantic-utility", "baseline-receipt.json")

export { canonicalJSON } from "#eval-harness/preregistration"

/**
 * Returns the content hash of a probe definition.
 */
export function probeDefinitionHash(definition: SemanticProbeDefinition): string {
	return definitionContentHash(definition)
}

/**
 * Audits a probe definition without running anything.
 *
 * It returns one message per problem, identifying the field or row ID.
 * An empty list means the definition can run.
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
 * Loads the frozen pre-registration after checking its identity, hash, and audit.
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
 * Resolves each control row to its committed fixture.
 *
 * It throws when a fixture is missing or differs from the frozen copy.
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
 * The measured outcome of one target or control row.
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
 * The primary, diagnostic, and control counts that a decision reads.
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
 * Counts a run's outcomes.
 *
 * The denominators come from the definition's registered row counts.
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
 * One decision with the counts and deltas that produced it.
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
 * Applies the frozen thresholds.
 *
 * Control regressions above tolerance give STOP-REDESIGN.
 * Otherwise the primary bars give GO, the diagnostic bars give DIAGNOSTIC-ONLY,
 * and anything else gives STOP-REDESIGN.
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
