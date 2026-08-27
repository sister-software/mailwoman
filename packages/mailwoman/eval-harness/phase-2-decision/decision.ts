/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FROZEN ruler for the phase-2 decision (#1967), and the arithmetic that reads it. Pure — no model,
 *   no database, no pipeline — so every refusal and every threshold is testable without loading an engine.
 *
 *   WHY A FOURTH PRE-REGISTRATION AND NOT A FOURTH COPY. #1928's ruler decides one lane against one frozen
 *   baseline; #1965's asserts one asymmetry. Phase 2 spans four lanes whose combined effect neither covers,
 *   so this file registers the LANES and the checks that read them, and takes the freeze machinery from
 *   {@linkcode canonicalJSON} rather than re-typing it. Two encoders hashing the same content drift at the
 *   first key ordering either one changes.
 *
 *   A BLOCKED LANE IS REGISTERED AND NEVER MEASURED. Mapping breadth (#1963) authored W1-1 and W1-2 and
 *   HELD W1-3 behind #1980, so its operational half cannot be measured at all today. There are two ways to
 *   get that wrong and the audit refuses both: a ruler that scores a blocked lane reports a number about
 *   nothing, and a ruler that omits it reports full coverage over three quarters of the phase. So a lane
 *   carries `status`, a `blocked` lane may register NO check ({@linkcode auditPhase2Definition} refuses
 *   one), it must name what blocks it and what its rows will read once unblocked, and every verdict carries
 *   {@linkcode Phase2Verdict.coverage} plus the blocked lane ids in its reasons.
 *
 *   EVERY LANE'S BASELINE IS A MERGED-PR RECEIPT, AND THE RULER SAYS SO. All six phase-2 implementation
 *   issues closed before this pre-registration was written, so there is no arm that ran first here. Each
 *   check therefore names the receipt standing in for a baseline — the PR that recorded it, and the number —
 *   and the run reproduces it. A baseline nobody can point at is indistinguishable from one chosen after the
 *   result was visible.
 *
 *   THE MEASUREMENTS ARE WHOLE ROW COUNTS. Every reading is an integer over a stated denominator, including
 *   the identity checks: a definition hash that has not moved reads `1`, a moved one reads `0`. That keeps
 *   every threshold a row count, the property #1928's audit already enforces, and keeps one comparison rule
 *   for the whole ruler instead of one per field type.
 *
 *   THIS FILE DECIDES WHAT THE RULER MAPS TO. It does not RECORD it. The recording is the operator's, and
 *   the definition's `recordingNote` says so on the receipt.
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { sha256Hex } from "@mailwoman/core/utils"

// The canonical-JSON encoder is IMPORTED rather than re-typed, for the reason the absence probe imports it.
import { canonicalJSON } from "../semantic-utility/probe.ts"

/**
 * The closed set of instruments a check may read. Adding one is a reviewed change to this file and to the runner that
 * produces its readings — never a string invented in the definition.
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
 * Every reading the runner produces, and which instrument produces it.
 *
 * The registry is closed for the same reason the comparator register is: a definition naming a measurement nothing
 * produces would report a check that silently never ran, and a check that cannot fail reads exactly like one that
 * passed.
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
 * The instrument a measurement belongs to.
 */
export function instrumentFor(measurement: Phase2Measurement): Phase2Instrument {
	return PHASE2_MEASUREMENTS[measurement]
}

/**
 * A lane is either measurable now or blocked. There is no third state: a lane whose instrument merely happens not to
 * have run is a harness break, and the runner refuses rather than reporting it as a lane state.
 */
export const PHASE2_LANE_STATUSES = ["measurable", "blocked"] as const

export type Phase2LaneStatus = (typeof PHASE2_LANE_STATUSES)[number]

/**
 * What a check decides. `control` checks assert nothing moved; `target` checks assert a capability.
 */
export const PHASE2_CHECK_ROLES = ["target", "control"] as const

export type Phase2CheckRole = (typeof PHASE2_CHECK_ROLES)[number]

/**
 * Which decision a target check speaks to.
 *
 * - `resolution` — the recognition capability itself: an activity phrase reaching the entity kinds that afford it, graded
 *   on the assembled answer. These are what "proceed to what the integration record authorized" rests on.
 * - `evidence` — the observation surface: the phrase attestations, the coverage-qualified absence rows, and the marker
 *   that carries an observation to a caller. The integration record's §7 names exactly this half as what a
 *   diagnostic-strength result would justify on its own.
 */
export const PHASE2_TARGET_TIERS = ["resolution", "evidence"] as const

export type Phase2TargetTier = (typeof PHASE2_TARGET_TIERS)[number]

/**
 * How an observation is compared against its bar. All three take a whole row count.
 */
export const PHASE2_BAR_KINDS = ["at_least", "at_most", "exactly"] as const

export type Phase2BarKind = (typeof PHASE2_BAR_KINDS)[number]

/**
 * Where a check's baseline number comes from. No lane of this phase ran before its implementation merged, so
 * `merged-pr-receipt` is the ordinary case rather than the exception.
 */
export const PHASE2_BASELINE_SOURCES = ["merged-pr-receipt", "committed-receipt", "committed-artifact"] as const

export type Phase2BaselineSource = (typeof PHASE2_BASELINE_SOURCES)[number]

/**
 * The three decisions this ruler admits, in the order {@linkcode decidePhase2} checks them.
 */
export const PHASE2_DECISIONS = ["PROCEED-AS-AUTHORIZED", "EVIDENCE-ONLY", "STOP-REDESIGN"] as const

export type Phase2Decision = (typeof PHASE2_DECISIONS)[number]

/**
 * What one row of the integration record's default-change bar reads today.
 *
 * The last two are their own states rather than kinds of `unmet`, because the three are different findings and a reader
 * acts on each differently: a row nobody can measure, a row whose instrument exists and this ruler does not run, and a
 * row measured and failing.
 */
export const PHASE2_DEFAULT_BAR_STATES = ["met", "unmet", "no_committed_instrument", "not_measured_here"] as const

export type Phase2DefaultBarState = (typeof PHASE2_DEFAULT_BAR_STATES)[number]

export interface Phase2Bar {
	kind: Phase2BarKind
	value: number
}

/**
 * The number a check is compared against, and the receipt that recorded it.
 */
export interface Phase2Baseline {
	source: Phase2BaselineSource
	/**
	 * The PR, the committed receipt file, or the committed artifact the number was read from.
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
	 * The lane this check belongs to. A check naming a `blocked` lane is refused.
	 */
	lane: string
	role: Phase2CheckRole
	/**
	 * Required on a `target` check, refused on a `control` one.
	 */
	tier?: Phase2TargetTier
	measurement: Phase2Measurement
	/**
	 * What is counted, in words, so a reader never has to infer it from the measurement key.
	 */
	numerator: string
	/**
	 * The registered denominator. Never "the rows that answered" — a probe that stops being able to read a row reports a
	 * lower numerator rather than a smaller board.
	 */
	denominator: number
	baseline: Phase2Baseline
	bar: Phase2Bar
	/**
	 * The failure this check would catch.
	 */
	guards: string
}

/**
 * A row a blocked lane will measure once it is unblocked. Registered so the blocked lane is described rather than
 * omitted, and never scored.
 */
export interface Phase2PlannedCheck {
	id: string
	measures: string
	/**
	 * What the same reading gives today, so the unblocking is a comparison rather than a fresh claim.
	 */
	todayReads: string
}

export interface Phase2Lane {
	id: string
	status: Phase2LaneStatus
	issue: string
	claim: string
	/**
	 * What merged for this lane regardless of its status — a blocked lane is rarely blocked in whole.
	 */
	landed: string
	note: string
	/**
	 * Required on a `blocked` lane: the issue that must land first.
	 */
	blockedBy?: string
	blockedReason?: string
	plannedChecks?: Phase2PlannedCheck[]
}

/**
 * One row of the integration record's default-change bar, recorded with what it reads today.
 *
 * This register is NEVER an input to {@linkcode decidePhase2}. It exists because "proceed to what the record authorized"
 * is a claim about a specific authorization — the opt-in surface — and a reader has to be able to see that the separate
 * bar for a default change is not met, rather than infer it from the absence of a claim.
 */
export interface Phase2DefaultBarRow {
	row: number
	check: string
	state: Phase2DefaultBarState
	/**
	 * Check ids that satisfy this row. Required non-empty on a `met` row: a row asserting itself satisfied without naming
	 * the measurement that satisfied it is prose.
	 */
	satisfiedBy: string[]
	note: string
}

export interface Phase2Thresholds {
	/**
	 * How many control checks may miss their bar. Zero: a capability bought by moving something that already worked is
	 * not a result this program can act on.
	 */
	controlRegressionTolerance: number
	/**
	 * How many `resolution`-tier target checks must hold for PROCEED-AS-AUTHORIZED.
	 */
	minimumResolutionChecks: number
	/**
	 * How many `evidence`-tier target checks must hold. Required by BOTH decisions: the authorized surface serves a
	 * category WITH the authority that chose it, so the evidence half is not an alternative to the resolution half.
	 */
	minimumEvidenceChecks: number
	/**
	 * How many lanes must report. Equal to the registered measurable-lane count — an instrument that could not run leaves
	 * a lane unreported, and an unreported lane is not a passing one.
	 */
	requiredMeasurableLanes: number
}

/**
 * The artifacts every measurement was registered against. Recorded, compared, and reported — never a decision input.
 *
 * A run on a rebuilt `poi.db` or a bumped weights package is still a run; it is just not comparable to the receipts
 * this ruler names as baselines, and {@linkcode Phase2Verdict.comparability} is where a reader sees that.
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
 * The one query the marker measurement runs, frozen here rather than written into the runner.
 */
export interface Phase2MarkerProbe {
	query: string
	locale?: string
	expectedCode: string
	expectedMechanism: string
	note: string
}

/**
 * The whole pre-registration, as committed.
 */
export interface Phase2DecisionDefinition {
	decisionID: string
	version: string
	issue: string
	program: string
	/**
	 * What PROCEED-AS-AUTHORIZED authorizes, named so the decision cannot be read as authorizing more.
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
 * The freeze record: the definition's identity and the content hash that pins it.
 */
export interface Phase2FreezeRecord {
	definition: string
	decisionID: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

function sourceRelative(name: string): string {
	// `tsc` emits no `.json` into `out/`, so a compiled caller reads the source-tree copy — the same bridge the two
	// earlier pre-registrations use.
	const sibling = fileURLToPath(new URL(name, import.meta.url))

	if (existsSync(sibling)) return sibling

	return fileURLToPath(new URL(`../../../eval-harness/phase-2-decision/${name}`, import.meta.url))
}

/**
 * The committed pre-registration.
 */
export const PHASE2_DEFINITION_PATH = sourceRelative("decision-definition.json")

/**
 * The committed freeze record for it.
 */
export const PHASE2_FREEZE_PATH = sourceRelative("decision-freeze.json")

/**
 * The committed receipt — the measured run the decision package on #1967 lays its arithmetic out of.
 *
 * Committed rather than left in a PR body for the reason this whole ruler exists: the numbers a decision rests on have
 * to be readable next to the definition that registered them, by someone who was not there.
 */
export const PHASE2_RECEIPT_PATH = sourceRelative("decision-receipt.json")

/**
 * The content hash of one definition.
 */
export function phase2DefinitionHash(definition: Phase2DecisionDefinition): string {
	return sha256Hex(canonicalJSON(definition))
}

function auditLanes(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const lane of definition.lanes) {
		if (seen.has(lane.id)) {
			problems.push(`lane id ${JSON.stringify(lane.id)} is used twice — ids name lanes in output`)
		}

		seen.add(lane.id)

		if (!(PHASE2_LANE_STATUSES as readonly string[]).includes(lane.status)) {
			problems.push(`lane ${lane.id}: status ${JSON.stringify(lane.status)} is not a registered lane status`)
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
			problems.push(`check ${check.id}: lane ${JSON.stringify(check.lane)} is not a registered lane`)
		}
	}

	return problems
}

function auditChecks(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const check of definition.checks) {
		if (seen.has(check.id)) {
			problems.push(`check id ${JSON.stringify(check.id)} is used twice — ids name checks in output`)
		}

		seen.add(check.id)

		if (!(PHASE2_CHECK_ROLES as readonly string[]).includes(check.role)) {
			problems.push(`check ${check.id}: role ${JSON.stringify(check.role)} is not a registered role`)
		}

		if (check.role === "target" && !check.tier) {
			problems.push(`check ${check.id}: a target check registers no tier, so no decision could read it`)
		}

		if (check.role === "control" && check.tier) {
			problems.push(
				`check ${check.id}: a control check registers tier ${JSON.stringify(check.tier)} — tiers are targets`
			)
		}

		if (check.tier && !(PHASE2_TARGET_TIERS as readonly string[]).includes(check.tier)) {
			problems.push(`check ${check.id}: tier ${JSON.stringify(check.tier)} is not a registered tier`)
		}

		if (!Object.hasOwn(PHASE2_MEASUREMENTS, check.measurement)) {
			problems.push(`check ${check.id}: measurement ${JSON.stringify(check.measurement)} is not registered`)
		}

		if (!Number.isInteger(check.denominator) || check.denominator <= 0) {
			problems.push(`check ${check.id}: denominator ${JSON.stringify(check.denominator)} is not a positive row count`)
		}

		if (!(PHASE2_BAR_KINDS as readonly string[]).includes(check.bar.kind)) {
			problems.push(`check ${check.id}: bar kind ${JSON.stringify(check.bar.kind)} is not registered`)
		}

		if (!Number.isInteger(check.bar.value) || check.bar.value < 0) {
			problems.push(`check ${check.id}: bar value ${JSON.stringify(check.bar.value)} is not a whole row count`)
		}

		if (check.bar.kind !== "at_most" && check.bar.value > check.denominator) {
			problems.push(
				`check ${check.id}: bar ${check.bar.kind} ${check.bar.value} exceeds the denominator ${check.denominator} — an unreachable bar can only ever record a miss`
			)
		}

		if (!(PHASE2_BASELINE_SOURCES as readonly string[]).includes(check.baseline.source)) {
			problems.push(`check ${check.id}: baseline source ${JSON.stringify(check.baseline.source)} is not registered`)
		}

		if (!check.baseline.reference.trim()) {
			problems.push(
				`check ${check.id}: baseline names no reference — a baseline nobody can point at is one chosen after the result`
			)
		}

		if (!Number.isInteger(check.baseline.value) || check.baseline.value < 0) {
			problems.push(
				`check ${check.id}: baseline value ${JSON.stringify(check.baseline.value)} is not a whole row count`
			)
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

function auditThresholds(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const thresholds = definition.thresholds

	for (const [key, value] of Object.entries(thresholds)) {
		if (!Number.isInteger(value) || value < 0) {
			problems.push(`thresholds.${key} is ${JSON.stringify(value)} — every threshold is a whole check count`)
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

function auditDefaultChangeBar(definition: Phase2DecisionDefinition): string[] {
	const problems: string[] = []
	const ids = new Set(definition.checks.map((check) => check.id))

	definition.defaultChangeBar.forEach((row, index) => {
		if (row.row !== index + 1) {
			problems.push(`defaultChangeBar[${index}]: row ${row.row} is out of order — the rows are the record's own 1..N`)
		}

		if (!(PHASE2_DEFAULT_BAR_STATES as readonly string[]).includes(row.state)) {
			problems.push(`defaultChangeBar row ${row.row}: state ${JSON.stringify(row.state)} is not registered`)
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
				problems.push(`defaultChangeBar row ${row.row}: satisfiedBy names ${JSON.stringify(id)}, which is not a check`)
			}
		}
	})

	return problems
}

/**
 * Everything that must be true of a definition, checked without running anything. One message per problem, each naming
 * the field, lane or check id. Empty means the definition is executable.
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
 * Load the frozen pre-registration, refusing anything that would let the ruler move.
 *
 * Three refusals, in order: the freeze record must name this definition and version, the definition's content hash must
 * equal the frozen hash, and the audit must be clean. A caller never receives a definition it may only partly trust.
 */
export function loadPhase2Definition(
	definitionPath: string = PHASE2_DEFINITION_PATH,
	freezePath: string = PHASE2_FREEZE_PATH
): Phase2DecisionDefinition {
	const definition = parseJSONStrict<Phase2DecisionDefinition>(readFileSync(definitionPath, "utf8"))
	const freeze = parseJSONStrict<Phase2FreezeRecord>(readFileSync(freezePath, "utf8"))

	if (freeze.decisionID !== definition.decisionID) {
		throw new Error(
			`phase-2 decision: freeze record names ${JSON.stringify(freeze.decisionID)}, definition is ${JSON.stringify(definition.decisionID)}`
		)
	}

	if (freeze.version !== definition.version) {
		throw new Error(
			`phase-2 decision: freeze record pins version ${freeze.version}, definition is ${definition.version} — a definition change bumps BOTH the version and the hash`
		)
	}

	const observed = phase2DefinitionHash(definition)

	if (observed !== freeze.sha256) {
		throw new Error(
			`phase-2 decision: definition content hash ${observed} !== frozen ${freeze.sha256} — the ruler moved. Restore it, or record a new version and hash in ${freeze.definition}`
		)
	}

	const problems = auditPhase2Definition(definition)

	if (problems.length) {
		throw new Error(
			["phase-2 decision: the pre-registration is not executable:", ...problems.map((p) => `  - ${p}`)].join("\n")
		)
	}

	return definition
}

/**
 * One instrument reading, addressed to the measurement it answers.
 */
export interface Phase2Reading {
	measurement: Phase2Measurement
	observed: number
	/**
	 * What produced the number, in the instrument's own words — carried so a check's outcome names the thing it read and
	 * not only the count.
	 */
	detail: string
}

/**
 * One check, measured.
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
 * Render one bar as the reader sees it beside the measurement.
 */
export function describeBar(bar: Phase2Bar): string {
	if (bar.kind === "at_least") return `≥ ${bar.value}`

	if (bar.kind === "at_most") return `≤ ${bar.value}`

	return `= ${bar.value}`
}

/**
 * Measure every registered check against the readings one run produced.
 *
 * REFUSES a check whose measurement no reading answers, rather than treating the absence as a miss. An unread
 * measurement is a broken instrument, and a broken instrument reporting `0` is indistinguishable from a real zero — the
 * one reading a decision must never be built on.
 */
export function evaluatePhase2Checks(
	definition: Phase2DecisionDefinition,
	readings: ReadonlyMap<Phase2Measurement, Phase2Reading>
): Phase2CheckOutcome[] {
	return definition.checks.map((check) => {
		const reading = readings.get(check.measurement)

		if (!reading) {
			throw new Error(
				`phase-2 decision: check ${check.id} reads ${JSON.stringify(check.measurement)}, which no instrument answered — an unread measurement is a broken instrument, never a zero`
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
 * The counts a decision reads.
 */
export interface Phase2Counts {
	resolutionChecks: number
	resolutionMet: number
	evidenceChecks: number
	evidenceMet: number
	controlChecks: number
	controlMet: number
	controlMisses: number
}

/**
 * Count one run. The denominators are the REGISTERED check counts.
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
 * What a run was measured against, beside what the ruler pinned.
 */
export interface Phase2Comparability {
	/**
	 * Every pinned artifact whose observed identity differs, named with both values. Empty means the run is comparable to
	 * the receipts the ruler cites as baselines.
	 */
	deviations: string[]
}

export interface Phase2Verdict {
	decision: Phase2Decision
	counts: Phase2Counts
	/**
	 * `partial` whenever any registered lane is blocked. Always stated: a verdict over three of four lanes is a different
	 * claim from a verdict over all of them, and only one of the two is what this run produced.
	 */
	coverage: "complete" | "partial"
	blockedLanes: string[]
	/**
	 * `deviated` when the run's artifacts differ from the pins. Reported, never a decision input — a decision measured on
	 * other artifacts is still a decision about those artifacts.
	 */
	comparability: "pinned" | "deviated"
	pinDeviations: string[]
	/**
	 * The default-change bar rows that do not read `met`. Recorded so nobody reads this decision as authorizing a default
	 * change; never an input.
	 */
	defaultChangeBarUnmetRows: number[]
	reasons: string[]
	/**
	 * Every check that missed its bar, named with its arithmetic.
	 */
	misses: string[]
}

/**
 * Map measured checks onto exactly one decision, against the frozen thresholds.
 *
 * ORDER IS LOAD-BEARING, and it is #1928's order. A control miss is checked FIRST and stops under both decisions: a
 * capability bought by moving something that already worked is not a result to act on. PROCEED-AS-AUTHORIZED is checked
 * before EVIDENCE-ONLY, and requires BOTH tiers — the surface the integration record authorizes serves a category
 * together with the authority that chose it, so the evidence half is a component of proceeding rather than an
 * alternative to it. EVIDENCE-ONLY is then exactly the record's §7 outcome: the observation surface holds and the
 * recognition capability did not reach its bar.
 *
 * A blocked lane changes no arithmetic. It changes `coverage`, and it is named in the reasons on every run.
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
