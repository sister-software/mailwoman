/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FROZEN ruler for the first geographic-model semantic-utility probe (#1928), and the arithmetic
 *   that reads it. Pure — no model, no database, no pipeline — so every refusal and every threshold is
 *   testable without loading an engine.
 *
 *   WHAT A FROZEN RULER IS. `probe-definition.json` states the target rows, the control rows, the
 *   comparator, the metric arithmetic, the measured baseline, and the three decision thresholds. #1929
 *   supplies one semantic observation and re-runs; #1930 reads the two runs against these numbers. None
 *   of them may choose a row or define "better" after a result is visible, so the definition is content-
 *   hashed into `probe-freeze.json` and {@linkcode loadProbeDefinition} REFUSES a definition whose hash
 *   has moved. The refusal is at load, not only in CI: a ruler that can be edited between the two arms
 *   measures nothing, and a test that runs an hour later cannot un-measure it.
 *
 *   THE COMPARATOR IS THE BOARD'S OWN. `poi_board_assembled_answer` is {@linkcode gradeCase} from
 *   `poi-board.ts` — the top result's category id and the nearest returned coordinate, and nothing else.
 *   That is the anti-Pelias commitment applied to this probe: it grades what comes out, never how it was
 *   produced, so a semantic arm cannot pass by reporting that it consulted an affordance.
 *
 *   THE OUTCOME SHAPES ARE POI SHAPES. {@linkcode POI_OUTCOME_SHAPES} is derived from `PipelineResult`'s
 *   own `path` and `POIIntentOutcome`'s own `type`. It is deliberately NOT a `DIAGNOSE_SHAPES` value:
 *   that vocabulary describes address-path mechanism states and carries no state for the POI branch, so
 *   borrowing one would name a state this probe never observes.
 *
 *   CONTROLS COME IN TWO GROUPS, AND BOTH DECIDE. `same_category` rows are the venue-noun form of the
 *   same intent, which passes today; they catch a semantic arm that breaks what already works.
 *   `adjacent` rows are a different category at the same anchor and a bare-category abstain; they catch
 *   the opposite failure — an arm that answers `pharmacy` for everything would leave the first group
 *   green. A control set that cannot fail is not a control set.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/utils"
import { fileURLToPath } from "@mailwoman/platform/url"

import {
	type CaseGrade,
	gradeCase,
	type POIBoardExpect,
	type POIBoardFixture,
	type POIBoardOutcome,
} from "../poi-board.ts"

/**
 * The closed set of outcome shapes this probe reads, derived from `PipelineResult["path"]` and
 * `POIIntentOutcome["type"]`.
 *
 * - `no_poi_branch` — the coordinator never took the POI branch, so there is no POI outcome at all. This is the measured
 *   baseline shape for every target row: an activity phrase scores `0` against the phrase lexicon, so the input is
 *   answered as an address parse of a sentence.
 * - `poi_abstain` — the branch was taken and declined; the reason travels beside the shape.
 * - `poi_intent_no_results` — the branch was taken, an intent was formed, and the executor returned nothing.
 * - `poi_intent_results` — the branch was taken and at least one row came back. The only shape the primary metric can
 *   grade, since the comparator reads the top result.
 */
export const POI_OUTCOME_SHAPES = [
	"no_poi_branch",
	"poi_abstain",
	"poi_intent_no_results",
	"poi_intent_results",
] as const

export type POIOutcomeShape = (typeof POI_OUTCOME_SHAPES)[number]

/**
 * Read the outcome shape off one pipeline result slice. Total over the vocabulary above — every reachable combination
 * of `path` and `poiIntent` names exactly one shape, so a caller never has to represent "could not tell".
 */
export function poiOutcomeShape(outcome: POIBoardOutcome): POIOutcomeShape {
	if (outcome.path !== "poi" || !outcome.poiIntent) return "no_poi_branch"

	if (outcome.poiIntent.type === "abstain") return "poi_abstain"

	return outcome.poiIntent.results?.length ? "poi_intent_results" : "poi_intent_no_results"
}

/**
 * The closed set of comparators this probe may register. One entry today; adding one is a reviewed instrument, never an
 * inline callback in the definition file.
 */
export const PROBE_COMPARATORS = ["poi_board_assembled_answer"] as const

export type ProbeComparatorName = (typeof PROBE_COMPARATORS)[number]

/**
 * Grade one row with a registered comparator. Refuses an unregistered name with the name in the message — a comparator
 * silently defaulted to another instrument would report a number nobody could trace to a contract.
 */
export function gradeWithComparator(
	comparator: ProbeComparatorName,
	fixture: POIBoardFixture,
	outcome: POIBoardOutcome
): CaseGrade {
	if (comparator !== "poi_board_assembled_answer") {
		throw new Error(`semantic-utility probe: unregistered outcome comparator ${JSON.stringify(comparator)}`)
	}

	return gradeCase(fixture, outcome)
}

/**
 * The three decisions the parent program admits. Exactly one is recorded at #1930.
 */
export const PROBE_DECISIONS = ["GO", "DIAGNOSTIC-ONLY", "STOP-REDESIGN"] as const

export type ProbeDecision = (typeof PROBE_DECISIONS)[number]

/**
 * One frozen target row: a POI-board fixture plus the record of where its query form and its anchor came from, and what
 * the baseline cannot distinguish about it.
 */
export interface ProbeTargetRow extends POIBoardFixture {
	/**
	 * Where the query FORM is attested. Route (a) commits these rows before the semantic arm exists, so the record has to
	 * say what the form is not: invented to pass.
	 */
	attestedIn: string
	/**
	 * The committed board row this row's anchor and expectation are copied from, byte-for-byte.
	 */
	anchorFrom: string
	/**
	 * The activity phrase that replaces the venue noun — the only thing that varies against `anchorFrom`.
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
 * The two control groups. Both decide; see the module header for why one alone is vacuous.
 */
export const PROBE_CONTROL_GROUPS = ["same_category", "adjacent"] as const

export type ProbeControlGroup = (typeof PROBE_CONTROL_GROUPS)[number]

/**
 * One frozen control row, referenced BY ID into a committed fixture file and carried here with its committed contents
 * so {@linkcode resolveControlRows} can refuse a reference that has drifted.
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
	 * The grade the row holds at baseline, and the grade it must still hold. `controlRegressionTolerance` is the number
	 * of rows allowed to move off this.
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
 * The frozen decision thresholds. Numbers, not adjectives, and all of them `>=` bars over stated denominators.
 */
export interface ProbeThresholds {
	/**
	 * GO — the primary numerator must reach this absolute count out of the primary denominator.
	 */
	minimumPrimaryNumerator: number
	/**
	 * GO — and it must gain at least this many rows over the frozen baseline. Stated as well as the absolute bar because
	 * a baseline that is not zero would make the absolute bar reachable without the observation moving anything.
	 */
	minimumPrimaryDelta: number
	/**
	 * DIAGNOSTIC-ONLY — the routing numerator must reach this absolute count out of the diagnostic denominator.
	 */
	minimumDiagnosticNumerator: number
	/**
	 * DIAGNOSTIC-ONLY — and gain at least this many rows over the frozen baseline.
	 */
	minimumDiagnosticDelta: number
	/**
	 * How many control rows may move off `expectedGrade`. Zero: a control regression is a stop under both decisions.
	 */
	controlRegressionTolerance: number
}

/**
 * The frozen baseline, measured against the pipeline before any semantic observation existed. #1930 compares the
 * post-injection run against exactly these numbers.
 */
export interface ProbeBaseline {
	measuredAt: string
	gitCommit: string
	primaryNumerator: number
	diagnosticNumerator: number
	controlHoldNumerator: number
	receipt: string
	/**
	 * What the numbers were measured against, in words — the tree state and anything about the run a bare sha does not
	 * carry.
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

async function sourceRelative(name: string): Promise<string> {
	// `tsc` emits no `.json` into `out/`, so a compiled caller reads the source-tree copy — the same bridge
	// `conformance/case-folding.ts` uses for its `.jsonl`.
	const sibling = fileURLToPath(new URL(name, import.meta.url))

	if (await pathExists(sibling)) return sibling

	return fileURLToPath(new URL(`../../../eval-harness/semantic-utility/${name}`, import.meta.url))
}

/**
 * The committed pre-registration.
 */
export const PROBE_DEFINITION_PATH = await sourceRelative("probe-definition.json")

/**
 * The committed freeze record for it.
 */
export const PROBE_FREEZE_PATH = await sourceRelative("probe-freeze.json")

/**
 * The committed baseline receipt — the pre-injection measurement the #1930 decision compares against.
 */
export const PROBE_BASELINE_RECEIPT_PATH = await sourceRelative("baseline-receipt.json")

/**
 * Canonical JSON for hashing: keys sorted at every depth, array order preserved, no insignificant whitespace.
 *
 * The hash covers CONTENT rather than bytes so a formatter pass cannot break the freeze and a reordered key cannot slip
 * past it. Array order is meaningful — row order is reported order — so it is never sorted.
 */
export function canonicalJSON(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"

	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

	return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJSON(entryValue)}`).join(",")}}`
}

/**
 * The content hash of one definition.
 */
export function probeDefinitionHash(definition: SemanticProbeDefinition): string {
	return sha256Hex(canonicalJSON(definition))
}

/**
 * Everything that must be true of a definition, checked without running anything. One message per problem, each naming
 * the field or row id. Empty means the definition is executable.
 */
export function auditProbeDefinition(definition: SemanticProbeDefinition): string[] {
	const problems: string[] = []

	if (!(PROBE_COMPARATORS as readonly string[]).includes(definition.outcomeComparator)) {
		problems.push(`outcomeComparator ${JSON.stringify(definition.outcomeComparator)} is not registered`)
	}

	if (!(POI_OUTCOME_SHAPES as readonly string[]).includes(definition.baselineFailureShape)) {
		problems.push(`baselineFailureShape ${JSON.stringify(definition.baselineFailureShape)} is not a POI outcome shape`)
	}

	if (!definition.targetRows.length) {
		problems.push("targetRows is empty — a probe with no target measures nothing")
	}

	if (!definition.controlRows.length) {
		problems.push("controlRows is empty — an uncontrolled delta is a claim about nothing")
	}

	const seen = new Set<string>()

	for (const row of [...definition.targetRows, ...definition.controlRows]) {
		if (seen.has(row.id)) {
			problems.push(`row id ${JSON.stringify(row.id)} is used twice — ids name rows in output`)
		}

		seen.add(row.id)
	}

	for (const row of definition.targetRows) {
		if (row.expect.kind !== "results") {
			problems.push(
				`target row ${row.id}: expect.kind is ${row.expect.kind}, but the primary metric grades an assembled answer`
			)
		}

		if (!(POI_OUTCOME_SHAPES as readonly string[]).includes(row.baselineShape)) {
			problems.push(
				`target row ${row.id}: baselineShape ${JSON.stringify(row.baselineShape)} is not a POI outcome shape`
			)
		}

		if (!row.missingDistinction.trim()) {
			problems.push(`target row ${row.id}: missingDistinction is blank`)
		}
	}

	for (const row of definition.controlRows) {
		if (!(PROBE_CONTROL_GROUPS as readonly string[]).includes(row.group)) {
			problems.push(`control row ${row.id}: group ${JSON.stringify(row.group)} is not a control group`)
		}

		if (!row.guards.trim()) {
			problems.push(`control row ${row.id}: guards is blank`)
		}
	}

	for (const group of PROBE_CONTROL_GROUPS) {
		if (!definition.controlRows.some((row) => row.group === group)) {
			problems.push(
				`control group ${JSON.stringify(group)} has no rows — see the module header for why one group alone is vacuous`
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
			problems.push(`thresholds.${key} is ${JSON.stringify(value)} — every threshold is a whole row count`)
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
 * Three refusals, in order: the freeze record must name this definition and version, the definition's content hash must
 * equal the frozen hash, and the audit must be clean. A caller never receives a definition it may only partly trust.
 */
export async function loadProbeDefinition(
	definitionPath: string = PROBE_DEFINITION_PATH,
	freezePath: string = PROBE_FREEZE_PATH
): Promise<SemanticProbeDefinition> {
	const definition = await readLocalJSONFile<SemanticProbeDefinition>(definitionPath)
	const freeze = await readLocalJSONFile<ProbeFreezeRecord>(freezePath)

	if (freeze.probeID !== definition.probeID) {
		throw new Error(
			`semantic-utility probe: freeze record names probe ${JSON.stringify(freeze.probeID)}, definition is ${JSON.stringify(definition.probeID)}`
		)
	}

	if (freeze.version !== definition.version) {
		throw new Error(
			`semantic-utility probe: freeze record pins version ${freeze.version}, definition is ${definition.version} — a definition change bumps BOTH the version and the hash`
		)
	}

	const observed = probeDefinitionHash(definition)

	if (observed !== freeze.sha256) {
		throw new Error(
			`semantic-utility probe: definition content hash ${observed} !== frozen ${freeze.sha256} — the ruler moved. Restore it, or record a new version and hash in ${freeze.definition}`
		)
	}

	const problems = auditProbeDefinition(definition)

	if (problems.length) {
		throw new Error(
			["semantic-utility probe: the pre-registration is not executable:", ...problems.map((p) => `  - ${p}`)].join("\n")
		)
	}

	return definition
}

/**
 * Refuse a control reference that does not resolve against its committed fixture file, or that resolves to a row whose
 * contents have moved.
 *
 * A drifted control is worse than a missing one: it still grades, still produces a number, and the number is about a
 * different row than the one the pre-registration named.
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
			throw new Error(`semantic-utility probe: control row ${JSON.stringify(row.id)} is not in ${row.source}`)
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
				`semantic-utility probe: control row ${JSON.stringify(row.id)} has moved in ${row.source}\n  frozen : ${declared}\n  committed: ${actual}`
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
 * Count one run.
 *
 * A target row that produced no outcome at all still counts against the denominator — the denominators are the
 * REGISTERED row counts, never the rows that happened to answer, so a probe that stops being able to read a row reports
 * a lower rate rather than a smaller board.
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
 * Map measured counts onto exactly one decision, against the frozen thresholds and the frozen baseline.
 *
 * Order is required. A control regression is checked FIRST and stops under both decisions: a target delta bought by
 * breaking the venue-noun form of the same query is not a result the program can act on. GO is checked before
 * DIAGNOSTIC-ONLY because a row that passes the comparator necessarily reached the POI branch, so the diagnostic
 * condition holds whenever the primary one does.
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
