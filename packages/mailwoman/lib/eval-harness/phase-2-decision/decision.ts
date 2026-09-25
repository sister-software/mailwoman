/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Frozen phase-2 decision definition, its audit, and the decision rule. The module loads no engine and writes no
 *   receipt.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import type { Phase2Comparability, Phase2Counts, Phase2Verdict } from "#eval-harness/phase-2-decision/outcomes"
import { definitionContentHash, loadFrozenDefinition, preregistrationPath } from "#eval-harness/preregistration"

export {
	type Phase2Comparability,
	type Phase2Counts,
	type Phase2Verdict,
} from "#eval-harness/phase-2-decision/outcomes"

/**
 * Instruments that produce registered measurements.
 */
export const PHASE2_INSTRUMENTS = [
	"semantic_utility_probe",
	"absence_observation_probe",
	"poi_board",
	"conformance_laws",
	"activity_lexicon",
	"committed_collision_census",
	"observation_marker",
] as const

export type Phase2Instrument = (typeof PHASE2_INSTRUMENTS)[number]

/**
 * Registered measurements, each mapped to the instrument that produces it.
 */
export const PHASE2_MEASUREMENTS = {
	"semantic_utility.baseline.primary_passes": "semantic_utility_probe",
	"semantic_utility.baseline.control_holds": "semantic_utility_probe",
	"semantic_utility.treatment.primary_passes": "semantic_utility_probe",
	"semantic_utility.treatment.diagnostic_reaches": "semantic_utility_probe",
	"semantic_utility.treatment.frozen_verdict_is_go": "semantic_utility_probe",
	"semantic_utility.treatment.control_holds": "semantic_utility_probe",
	"semantic_utility.definition_hash_matches_pin": "semantic_utility_probe",
	"semantic_utility.route_identity_matches_pins": "semantic_utility_probe",
	"activity_lexicon.declared_phrases": "activity_lexicon",
	"activity_lexicon.attestation_classes": "activity_lexicon",
	"activity_lexicon.locale_scoped_entries": "activity_lexicon",
	"collision_census.category_lexicon_collisions": "committed_collision_census",
	"collision_census.name_exact_legitimate_collisions": "committed_collision_census",
	"collision_census.name_exact_query_shaped_collisions": "committed_collision_census",
	"collision_census.identity_matches_pins": "committed_collision_census",
	"absence_probe.rows_holding": "absence_observation_probe",
	"absence_probe.targets_fired": "absence_observation_probe",
	"absence_probe.controls_silent": "absence_observation_probe",
	"absence_probe.definition_hash_matches_pin": "absence_observation_probe",
	"poi_board.floors_unmet": "poi_board",
	"poi_board.counted_rows": "poi_board",
	"poi_board.counted_passing": "poi_board",
	"poi_board.tracked_rows": "poi_board",
	"conformance.decided_rows": "conformance_laws",
	"conformance.decided_failures": "conformance_laws",
	"conformance.unmeasured_rows": "conformance_laws",
	"observation_marker.semantic_marker_reaches_caller": "observation_marker",
} as const satisfies Record<string, Phase2Instrument>

export type Phase2Measurement = keyof typeof PHASE2_MEASUREMENTS

/**
 * Returns the instrument that produces a measurement.
 */
export function instrumentFor(measurement: Phase2Measurement): Phase2Instrument {
	return PHASE2_MEASUREMENTS[measurement]
}

/**
 * Lane statuses.
 *
 * A blocked lane is described in the definition and has no scored checks.
 */
export const PHASE2_LANE_STATUSES = ["measurable", "blocked"] as const

export type Phase2LaneStatus = (typeof PHASE2_LANE_STATUSES)[number]

/**
 * Check roles.
 *
 * A `control` check asserts that existing behavior did not regress.
 * A `target` check asserts a new capability.
 */
export const PHASE2_CHECK_ROLES = ["target", "control"] as const

export type Phase2CheckRole = (typeof PHASE2_CHECK_ROLES)[number]

/**
 * Target tiers.
 *
 * A `resolution` check measures recognition capability, and an `evidence` check
 * measures what the caller can observe.
 */
export const PHASE2_TARGET_TIERS = ["resolution", "evidence"] as const

export type Phase2TargetTier = (typeof PHASE2_TARGET_TIERS)[number]

/**
 * Comparisons between an observed row count and a bar value.
 */
export const PHASE2_BAR_KINDS = ["at_least", "at_most", "exactly"] as const

export type Phase2BarKind = (typeof PHASE2_BAR_KINDS)[number]

/**
 * Kinds of source that a check's baseline value can cite.
 */
export const PHASE2_BASELINE_SOURCES = ["merged-pr-receipt", "committed-receipt", "committed-artifact"] as const

export type Phase2BaselineSource = (typeof PHASE2_BASELINE_SOURCES)[number]

/**
 * Possible decisions, from most to least permissive.
 */
export const PHASE2_DECISIONS = ["PROCEED-AS-AUTHORIZED", "EVIDENCE-ONLY", "STOP-REDESIGN"] as const

export type Phase2Decision = (typeof PHASE2_DECISIONS)[number]

/**
 * States of a default-change requirement from the integration record.
 */
export const PHASE2_DEFAULT_BAR_STATES = ["met", "unmet", "no_committed_instrument", "not_measured_here"] as const

export type Phase2DefaultBarState = (typeof PHASE2_DEFAULT_BAR_STATES)[number]

/**
 * Pass condition for a check, as a comparison against a whole row count.
 */
export interface Phase2Bar {
	kind: Phase2BarKind
	value: number
}

/**
 * Baseline value and the source it was read from.
 */
export interface Phase2Baseline {
	source: Phase2BaselineSource
	/**
	 * PR, committed receipt file, or committed artifact that holds the value.
	 */
	reference: string
	value: number
	note: string
}

/**
 * One registered check.
 */
export interface Phase2Check {
	id: string
	/**
	 * ID of the owning lane, which must be measurable.
	 */
	lane: string
	role: Phase2CheckRole
	/**
	 * Tier of a target check.
	 * Control checks must omit it.
	 */
	tier?: Phase2TargetTier
	measurement: Phase2Measurement
	/**
	 * Description of what the numerator counts.
	 */
	numerator: string
	/**
	 * Fixed row count.
	 *
	 * Unread rows lower the numerator and leave the denominator unchanged.
	 */
	denominator: number
	baseline: Phase2Baseline
	bar: Phase2Bar
	/**
	 * Failure that this check guards against.
	 */
	guards: string
}

/**
 * Planned check for a blocked lane.
 * It is recorded and not scored.
 */
export interface Phase2PlannedCheck {
	id: string
	measures: string
	/**
	 * Current value of the same reading, which the check will be compared against once the lane unblocks.
	 */
	todayReads: string
}

/**
 * One work lane in the phase.
 */
export interface Phase2Lane {
	id: string
	status: Phase2LaneStatus
	issue: string
	claim: string
	/**
	 * Work that has merged for the lane.
	 * A blocked lane usually has some.
	 */
	landed: string
	note: string
	/**
	 * Issue that must land before a blocked lane can be measured.
	 * The audit requires it on a blocked lane.
	 */
	blockedBy?: string
	blockedReason?: string
	plannedChecks?: Phase2PlannedCheck[]
}

/**
 * Default-change requirement from the integration record and its current state.
 *
 * The verdict reports these rows, and they do not affect {@linkcode decidePhase2}'s decision.
 */
export interface Phase2DefaultBarRow {
	row: number
	check: string
	state: Phase2DefaultBarState
	/**
	 * IDs of the checks that satisfy the row.
	 * A `met` row must list at least one.
	 */
	satisfiedBy: string[]
	note: string
}

/**
 * Frozen decision thresholds, all whole check counts.
 */
export interface Phase2Thresholds {
	/**
	 * Number of control misses allowed.
	 */
	controlRegressionTolerance: number
	/**
	 * Number of resolution checks that must pass for `PROCEED-AS-AUTHORIZED`.
	 */
	minimumResolutionChecks: number
	/**
	 * Number of evidence checks that must pass for either positive decision.
	 */
	minimumEvidenceChecks: number
	/**
	 * Number of measurable lanes that must report.
	 * The audit requires it to equal the measurable lane count.
	 */
	requiredMeasurableLanes: number
}

/**
 * Artifact versions used to report comparability.
 * They are not decision inputs.
 */
export interface Phase2ArtifactPins {
	poiLayerManifestVersion: string
	poiLayerBuildSHA: string
	weightsLocale: string
	weightsVersion: string
	resolverBackend: string
	geographicModelVersion: string
	phraseLexiconID: string
	phraseLexiconVersion: string
	declaredPhrases: number
	semanticUtilityDefinitionSHA256: string
	absenceDefinitionSHA256: string
	coverageLayerFile: string
	coverageLayerVersion: string
}

/**
 * Query and expected result for the observation-marker probe.
 */
export interface Phase2MarkerProbe {
	query: string
	locale?: string
	expectedCode: string
	expectedMechanism: string
	note: string
}

/**
 * Complete phase-2 preregistration.
 */
export interface Phase2DecisionDefinition {
	decisionID: string
	version: string
	issue: string
	program: string
	/**
	 * Scope authorized by `PROCEED-AS-AUTHORIZED`.
	 */
	authorizedOutcome: string
	scopeNote: string
	baselineNote: string
	artifactPins: Phase2ArtifactPins
	markerProbe: Phase2MarkerProbe
	lanes: Phase2Lane[]
	checks: Phase2Check[]
	thresholds: Phase2Thresholds
	thresholdsNote: string
	defaultChangeBar: Phase2DefaultBarRow[]
	defaultChangeBarNote: string
	decisionRule: string[]
	recordingNote: string
}

/**
 * Freeze record that pins the definition by ID, version, and content hash.
 */
export interface Phase2FreezeRecord {
	definition: string
	decisionID: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

/**
 * Path to the committed preregistration.
 */
export const PHASE2_DEFINITION_PATH = preregistrationPath("phase-2-decision", "decision-definition.json")

/**
 * Path to the committed freeze record.
 */
export const PHASE2_FREEZE_PATH = preregistrationPath("phase-2-decision", "decision-freeze.json")

/**
 * Path to the committed measurement receipt.
 */
export const PHASE2_RECEIPT_PATH = preregistrationPath("phase-2-decision", "decision-receipt.json")

/**
 * Returns the content hash that the freeze record pins.
 */
export function phase2DefinitionHash(definition: Phase2DecisionDefinition): string {
	return definitionContentHash(definition)
}

/**
 * Audits lane IDs and statuses, the checks a lane may own, and the details a blocked lane must record.
 */
function auditLanes(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const lane of definition.lanes) {
		if (seen.has(lane.id)) {
			problems.push(`lane id ${stringifyJSON(lane.id)} is used twice — ids name lanes in output`)
		}

		seen.add(lane.id)

		if (!(PHASE2_LANE_STATUSES as readonly string[]).includes(lane.status)) {
			problems.push(`lane ${lane.id}: status ${stringifyJSON(lane.status)} is not a registered lane status`)
		}

		if (!lane.claim.trim()) {
			problems.push(`lane ${lane.id}: claim is blank`)
		}

		if (!lane.landed.trim()) {
			problems.push(`lane ${lane.id}: landed is blank`)
		}

		const laneChecks = definition.checks.filter((check) => check.lane === lane.id)

		if (lane.status === "blocked") {
			if (laneChecks.length) {
				problems.push(
					`lane ${lane.id} is blocked and registers ${laneChecks.length} check(s) — a blocked lane is described, never scored`
				)
			}

			if (!lane.blockedBy?.trim()) {
				problems.push(`lane ${lane.id} is blocked and names nothing that blocks it`)
			}

			if (!lane.blockedReason?.trim()) {
				problems.push(`lane ${lane.id} is blocked and states no reason`)
			}

			if (!lane.plannedChecks?.length) {
				problems.push(
					`lane ${lane.id} is blocked and registers no planned check — a lane recorded as blocked without what it will measure is an omission with a label on it`
				)
			}

			for (const planned of lane.plannedChecks ?? []) {
				if (!planned.measures.trim()) {
					problems.push(`lane ${lane.id}, planned ${planned.id}: measures is blank`)
				}

				if (!planned.todayReads.trim()) {
					problems.push(`lane ${lane.id}, planned ${planned.id}: todayReads is blank`)
				}
			}

			continue
		}

		if (!laneChecks.length) {
			problems.push(
				`lane ${lane.id} is measurable and registers no check — a lane that measures nothing decides nothing`
			)
		}

		if (!laneChecks.some((check) => check.role === "control")) {
			problems.push(`lane ${lane.id} registers no control check — a lane that cannot fail is not a lane`)
		}

		if (lane.plannedChecks?.length) {
			problems.push(
				`lane ${lane.id} is measurable and registers planned checks — planned rows belong to a blocked lane`
			)
		}
	}

	for (const check of definition.checks) {
		if (!seen.has(check.lane)) {
			problems.push(`check ${check.id}: lane ${stringifyJSON(check.lane)} is not a registered lane`)
		}
	}

	return problems
}

/**
 * Audits each check's ID, role, tier, measurement, bar, and baseline.
 */
function auditChecks(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const check of definition.checks) {
		if (seen.has(check.id)) {
			problems.push(`check id ${stringifyJSON(check.id)} is used twice — ids name checks in output`)
		}

		seen.add(check.id)

		if (!(PHASE2_CHECK_ROLES as readonly string[]).includes(check.role)) {
			problems.push(`check ${check.id}: role ${stringifyJSON(check.role)} is not a registered role`)
		}

		if (check.role === "target" && !check.tier) {
			problems.push(`check ${check.id}: a target check registers no tier, so no decision could read it`)
		}

		if (check.role === "control" && check.tier) {
			problems.push(
				`check ${check.id}: a control check registers tier ${stringifyJSON(check.tier)} — tiers are targets`
			)
		}

		if (check.tier && !(PHASE2_TARGET_TIERS as readonly string[]).includes(check.tier)) {
			problems.push(`check ${check.id}: tier ${stringifyJSON(check.tier)} is not a registered tier`)
		}

		if (!Object.hasOwn(PHASE2_MEASUREMENTS, check.measurement)) {
			problems.push(`check ${check.id}: measurement ${stringifyJSON(check.measurement)} is not registered`)
		}

		if (!Number.isInteger(check.denominator) || check.denominator <= 0) {
			problems.push(`check ${check.id}: denominator ${stringifyJSON(check.denominator)} is not a positive row count`)
		}

		if (!(PHASE2_BAR_KINDS as readonly string[]).includes(check.bar.kind)) {
			problems.push(`check ${check.id}: bar kind ${stringifyJSON(check.bar.kind)} is not registered`)
		}

		if (!Number.isInteger(check.bar.value) || check.bar.value < 0) {
			problems.push(`check ${check.id}: bar value ${stringifyJSON(check.bar.value)} is not a whole row count`)
		}

		if (check.bar.kind !== "at_most" && check.bar.value > check.denominator) {
			problems.push(
				`check ${check.id}: bar ${check.bar.kind} ${check.bar.value} exceeds the denominator ${check.denominator} — an unreachable bar can only ever record a miss`
			)
		}

		if (!(PHASE2_BASELINE_SOURCES as readonly string[]).includes(check.baseline.source)) {
			problems.push(`check ${check.id}: baseline source ${stringifyJSON(check.baseline.source)} is not registered`)
		}

		if (!check.baseline.reference.trim()) {
			problems.push(
				`check ${check.id}: baseline names no reference — a baseline nobody can point at is one chosen after the result`
			)
		}

		if (!Number.isInteger(check.baseline.value) || check.baseline.value < 0) {
			problems.push(`check ${check.id}: baseline value ${stringifyJSON(check.baseline.value)} is not a whole row count`)
		}

		if (!check.numerator.trim()) {
			problems.push(`check ${check.id}: numerator is blank`)
		}

		if (!check.guards.trim()) {
			problems.push(`check ${check.id}: guards is blank`)
		}
	}

	return problems
}

/**
 * Audits the thresholds against the registered check and lane counts.
 */
function auditThresholds(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const thresholds = definition.thresholds

	for (const [key, value] of Object.entries(thresholds)) {
		if (!Number.isInteger(value) || value < 0) {
			problems.push(`thresholds.${key} is ${stringifyJSON(value)} — every threshold is a whole check count`)
		}
	}

	const controls = definition.checks.filter((check) => check.role === "control").length
	const resolution = definition.checks.filter((check) => check.tier === "resolution").length
	const evidence = definition.checks.filter((check) => check.tier === "evidence").length
	const measurableLanes = definition.lanes.filter((lane) => lane.status === "measurable").length

	if (!resolution) {
		problems.push("no resolution-tier check is registered — PROCEED-AS-AUTHORIZED would rest on nothing")
	}

	if (!evidence) {
		problems.push("no evidence-tier check is registered — EVIDENCE-ONLY would rest on nothing")
	}

	if (thresholds.minimumResolutionChecks > resolution) {
		problems.push(
			`thresholds.minimumResolutionChecks ${thresholds.minimumResolutionChecks} exceeds the ${resolution} registered resolution checks`
		)
	}

	if (thresholds.minimumEvidenceChecks > evidence) {
		problems.push(
			`thresholds.minimumEvidenceChecks ${thresholds.minimumEvidenceChecks} exceeds the ${evidence} registered evidence checks`
		)
	}

	if (controls && thresholds.controlRegressionTolerance >= controls) {
		problems.push(
			`thresholds.controlRegressionTolerance ${thresholds.controlRegressionTolerance} allows every control check to miss — the control set would decide nothing`
		)
	}

	if (thresholds.requiredMeasurableLanes !== measurableLanes) {
		problems.push(
			`thresholds.requiredMeasurableLanes ${thresholds.requiredMeasurableLanes} !== ${measurableLanes} measurable lanes — a lane that need not report is one that can go missing unnoticed`
		)
	}

	return problems
}

/**
 * Audits the default-change rows for order, state, and references to registered checks.
 */
function auditDefaultChangeBar(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const ids = new Set(definition.checks.map((check) => check.id))

	definition.defaultChangeBar.forEach((row, index) => {
		if (row.row !== index + 1) {
			problems.push(`defaultChangeBar[${index}]: row ${row.row} is out of order — the rows are the record's own 1..N`)
		}

		if (!(PHASE2_DEFAULT_BAR_STATES as readonly string[]).includes(row.state)) {
			problems.push(`defaultChangeBar row ${row.row}: state ${stringifyJSON(row.state)} is not registered`)
		}

		if (!row.check.trim()) {
			problems.push(`defaultChangeBar row ${row.row}: check is blank`)
		}

		if (!row.note.trim()) {
			problems.push(`defaultChangeBar row ${row.row}: note is blank`)
		}

		if (row.state === "met" && !row.satisfiedBy.length) {
			problems.push(
				`defaultChangeBar row ${row.row} reads met and names no check — a row asserting itself satisfied is prose`
			)
		}

		for (const id of row.satisfiedBy) {
			if (!ids.has(id)) {
				problems.push(`defaultChangeBar row ${row.row}: satisfiedBy names ${stringifyJSON(id)}, which is not a check`)
			}
		}
	})

	return problems
}

/**
 * Audits a definition without running any instrument.
 *
 * It returns one message per problem, and an empty list means the definition can run.
 */
export function auditPhase2Definition(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []

	if (!definition.lanes.length) {
		problems.push("lanes is empty — a phase ruler with no lane measures nothing")
	}

	if (!definition.checks.length) {
		problems.push("checks is empty — a ruler with no check measures nothing")
	}

	if (!definition.decisionRule.length) {
		problems.push("decisionRule is empty")
	}

	if (!definition.recordingNote.trim()) {
		problems.push("recordingNote is blank — the receipt must say whose the recording is")
	}

	if (!definition.markerProbe.query.trim()) {
		problems.push("markerProbe.query is blank")
	}

	problems.push(...auditLanes(definition))
	problems.push(...auditChecks(definition))
	problems.push(...auditThresholds(definition))
	problems.push(...auditDefaultChangeBar(definition))

	return problems
}

/**
 * Loads the frozen preregistration.
 *
 * It throws unless the freeze record matches the definition's ID and version,
 * the content hash matches the frozen hash, and the audit is clean.
 */
export async function loadPhase2Definition(
	definitionPath: PathBuilderLike = PHASE2_DEFINITION_PATH,
	freezePath: PathBuilderLike = PHASE2_FREEZE_PATH
): Promise<Phase2DecisionDefinition> {
	return loadFrozenDefinition({
		definitionPath,
		freezePath,
		label: "phase-2 decision",
		idField: "decisionID",
		audit: auditPhase2Definition,
	})
}

/**
 * Instrument reading for one measurement.
 */
export interface Phase2Reading {
	measurement: Phase2Measurement
	observed: number
	/**
	 * Instrument's description of what it counted.
	 * The check outcome repeats it next to the number.
	 */
	detail: string
}

/**
 * Result of evaluating one check against its reading.
 */
export interface Phase2CheckOutcome {
	id: string
	lane: string
	role: Phase2CheckRole
	tier?: Phase2TargetTier
	measurement: Phase2Measurement
	observed: number
	denominator: number
	baselineValue: number
	bar: Phase2Bar
	met: boolean
	detail: string
}

function barHolds(bar: Phase2Bar, observed: number): boolean {
	if (bar.kind === "at_least") return observed >= bar.value

	if (bar.kind === "at_most") return observed <= bar.value

	return observed === bar.value
}

/**
 * Formats a bar as a comparison such as `≥ 3`.
 */
export function describeBar(bar: Phase2Bar): string {
	if (bar.kind === "at_least") return `≥ ${bar.value}`

	if (bar.kind === "at_most") return `≤ ${bar.value}`

	return `= ${bar.value}`
}

/**
 * Evaluates every registered check against the readings.
 *
 * @throws When a check's measurement has no reading.
 * A missing reading means an instrument failed to run.
 */
export function evaluatePhase2Checks(
	definition: Phase2DecisionDefinition,
	readings: ReadonlyMap<Phase2Measurement, Phase2Reading>
): Phase2CheckOutcome[] {
	return definition.checks.map((check) => {
		const reading = readings.get(check.measurement)

		if (!reading) {
			throw new Error(
				`phase-2 decision: check ${check.id} reads ${stringifyJSON(check.measurement)}, which no instrument answered — an unread measurement is a broken instrument, never a zero`
			)
		}

		return {
			id: check.id,
			lane: check.lane,
			role: check.role,
			...(check.tier ? { tier: check.tier } : {}),
			measurement: check.measurement,
			observed: reading.observed,
			denominator: check.denominator,
			baselineValue: check.baseline.value,
			bar: check.bar,
			met: barHolds(check.bar, reading.observed),
			detail: reading.detail,
		}
	})
}

/**
 * Counts passing checks per tier and role.
 *
 * The totals come from the definition, so a missing outcome counts as a miss.
 */
export function computePhase2Counts(
	definition: Phase2DecisionDefinition,
	outcomes: readonly Phase2CheckOutcome[]
): Phase2Counts {
	const resolution = outcomes.filter((outcome) => outcome.tier === "resolution")
	const evidence = outcomes.filter((outcome) => outcome.tier === "evidence")
	const controls = outcomes.filter((outcome) => outcome.role === "control")

	return {
		resolutionChecks: definition.checks.filter((check) => check.tier === "resolution").length,
		resolutionMet: resolution.filter((outcome) => outcome.met).length,
		evidenceChecks: definition.checks.filter((check) => check.tier === "evidence").length,
		evidenceMet: evidence.filter((outcome) => outcome.met).length,
		controlChecks: definition.checks.filter((check) => check.role === "control").length,
		controlMet: controls.filter((outcome) => outcome.met).length,
		controlMisses: controls.filter((outcome) => !outcome.met).length,
	}
}

/**
 * Applies the frozen thresholds.
 *
 * Too many control misses or a missing measurable lane stops the phase.
 * Otherwise the evidence and resolution bars choose between the three decisions.
 *
 * Blocked lanes appear in the coverage report and do not change the counts.
 */
export function decidePhase2(
	definition: Phase2DecisionDefinition,
	outcomes: readonly Phase2CheckOutcome[],
	comparability: Phase2Comparability = { deviations: [] }
): Phase2Verdict {
	const counts = computePhase2Counts(definition, outcomes)
	const thresholds = definition.thresholds
	const blockedLanes = definition.lanes.filter((lane) => lane.status === "blocked").map((lane) => lane.id)
	const reportedLanes = new Set(outcomes.map((outcome) => outcome.lane))

	const defaultChangeBarUnmetRows = definition.defaultChangeBar
		.filter((row) => row.state !== "met")
		.map((row) => row.row)

	const misses = outcomes
		.filter((outcome) => !outcome.met)
		.map(
			(outcome) =>
				`${outcome.id} (${outcome.role}${outcome.tier ? `/${outcome.tier}` : ""}): ${outcome.observed}/${outcome.denominator} against ${describeBar(outcome.bar)} — ${outcome.detail}`
		)

	const reasons = [
		`control ${counts.controlMet}/${counts.controlChecks} (misses ${counts.controlMisses}; tolerance ${thresholds.controlRegressionTolerance})`,
		`resolution ${counts.resolutionMet}/${counts.resolutionChecks} (bar ${thresholds.minimumResolutionChecks})`,
		`evidence ${counts.evidenceMet}/${counts.evidenceChecks} (bar ${thresholds.minimumEvidenceChecks})`,
		`lanes reporting ${reportedLanes.size}/${thresholds.requiredMeasurableLanes}`,
		blockedLanes.length
			? `blocked lanes not measured by this ruler: ${blockedLanes.map((lane) => `${lane} (${definition.lanes.find((registered) => registered.id === lane)?.blockedBy})`).join(", ")}`
			: "no blocked lane — coverage is the whole phase",
		defaultChangeBarUnmetRows.length
			? `the integration record's default-change bar is NOT met: rows ${defaultChangeBarUnmetRows.join(", ")} — this decision authorizes no default change`
			: "the integration record's default-change bar reads met on every row",
	]

	const verdict = {
		counts,
		coverage: blockedLanes.length ? ("partial" as const) : ("complete" as const),
		blockedLanes,
		comparability: comparability.deviations.length ? ("deviated" as const) : ("pinned" as const),
		pinDeviations: comparability.deviations,
		defaultChangeBarUnmetRows,
		misses,
	}

	if (counts.controlMisses > thresholds.controlRegressionTolerance) {
		return { decision: "STOP-REDESIGN", ...verdict, reasons: [...reasons, "control misses exceed tolerance"] }
	}

	if (reportedLanes.size < thresholds.requiredMeasurableLanes) {
		return {
			decision: "STOP-REDESIGN",
			...verdict,
			reasons: [...reasons, "a measurable lane did not report — an unreported lane is not a passing one"],
		}
	}

	const evidenceHolds = counts.evidenceMet >= thresholds.minimumEvidenceChecks

	if (evidenceHolds && counts.resolutionMet >= thresholds.minimumResolutionChecks) {
		return { decision: "PROCEED-AS-AUTHORIZED", ...verdict, reasons }
	}

	if (evidenceHolds) {
		return {
			decision: "EVIDENCE-ONLY",
			...verdict,
			reasons: [...reasons, "the evidence bar was reached and the resolution bar was not"],
		}
	}

	return { decision: "STOP-REDESIGN", ...verdict, reasons: [...reasons, "the evidence bar was not reached"] }
}
