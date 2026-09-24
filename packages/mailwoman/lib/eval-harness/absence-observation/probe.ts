/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Frozen definition and scoring for the absence-observation probe. Targets expect an observation only inside
 *   exclusion-grade coverage; controls expect silence. Every row must match its registered outcome and category set.
 *   Anchors come from gazetteer places in pilot-layer coverage cells. This module is pure and audits definitions
 *   without loading a model or database.
 */

import { stringifyJSON } from "@mailwoman/core/json"
// Share canonical JSON encoding with the freeze-record implementation.
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import {
	definitionContentHash,
	duplicateRowIDProblems,
	loadFrozenDefinition,
	preregistrationPath,
} from "#eval-harness/preregistration"
import { ABSENCE_REFUSALS } from "#observations/index"

/**
 * Expected outcome for one registered row.
 */
export const ABSENCE_EXPECTED_OUTCOMES = ["absence_observation", ...ABSENCE_REFUSALS] as const

export type AbsenceExpectedOutcome = (typeof ABSENCE_EXPECTED_OUTCOMES)[number]

/**
 * Target and control row groups.
 */
export const ABSENCE_ROW_GROUPS = ["target", "outside_coverage", "wrong_class", "cell_populated"] as const

export type AbsenceRowGroup = (typeof ABSENCE_ROW_GROUPS)[number]

/**
 * One row in the frozen definition.
 */
export interface AbsenceProbeRow {
	id: string
	group: AbsenceRowGroup
	query: string
	locale?: string
	expectedOutcome: AbsenceExpectedOutcome
	/**
	 * Whether semantic phrase routing is needed to form a POI intent.
	 */
	requiresSemanticRoute: boolean
	/**
	 * Registered category set in code-point order; the runner checks the actual searched set against it.
	 */
	searchedCategories?: string[]
	/**
	 * Reproducible derivation of the anchor.
	 */
	anchorDerivation: string
	/**
	 * Regression guarded by this row.
	 */
	guards: string
}

/**
 * Frozen probe definition.
 */
export interface AbsenceProbeDefinition {
	probeID: string
	version: string
	issue: string
	claim: string
	asymmetry: string
	/**
	 * Coverage-layer filename under `$MAILWOMAN_DATA_ROOT/db/poi/`.
	 */
	coverageLayerFile: string
	coverageLayerNote: string
	rows: AbsenceProbeRow[]
	rowsNote: string
	/**
	 * Required number of rows matching their registered outcomes.
	 */
	requiredRowHolds: number
	decisionRule: string[]
}

/**
 * Freeze record pinning the definition by ID, version, and hash.
 */
export interface AbsenceProbeFreezeRecord {
	definition: string
	probeID: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

/**
 * Path to the committed definition.
 */
export const ABSENCE_PROBE_DEFINITION_PATH = preregistrationPath("absence-observation", "probe-definition.json")

/**
 * Path to the committed freeze record.
 */
export const ABSENCE_PROBE_FREEZE_PATH = preregistrationPath("absence-observation", "probe-freeze.json")

/**
 * Hash a definition.
 */
export function absenceProbeDefinitionHash(definition: AbsenceProbeDefinition): string {
	return definitionContentHash(definition)
}

/**
 * Audit a definition without running the probe; return one message per problem.
 */
export function auditAbsenceProbeDefinition(definition: AbsenceProbeDefinition): string[] {
	const problems: string[] = []

	if (!definition.rows.length) {
		problems.push("rows is empty — a probe with no row measures nothing")
	}

	problems.push(...duplicateRowIDProblems(definition.rows))

	for (const row of definition.rows) {
		if (!(ABSENCE_ROW_GROUPS as readonly string[]).includes(row.group)) {
			problems.push(`row ${row.id}: group ${stringifyJSON(row.group)} is not a registered group`)
		}

		if (!(ABSENCE_EXPECTED_OUTCOMES as readonly string[]).includes(row.expectedOutcome)) {
			problems.push(`row ${row.id}: expectedOutcome ${stringifyJSON(row.expectedOutcome)} is not a registered outcome`)
		}

		if (row.group === "target" && row.expectedOutcome !== "absence_observation") {
			problems.push(
				`row ${row.id}: a target row expects ${stringifyJSON(row.expectedOutcome)} — a target that does not expect the observation measures nothing about the route firing`
			)
		}

		if (row.group !== "target" && row.expectedOutcome === "absence_observation") {
			problems.push(
				`row ${row.id}: a ${row.group} control expects the observation — the control groups exist to assert silence`
			)
		}

		if (row.searchedCategories !== undefined) {
			const sorted = [...new Set(row.searchedCategories)].toSorted(compareByCodePoint)

			if (!row.searchedCategories.length || sorted.join("\u0000") !== row.searchedCategories.join("\u0000")) {
				problems.push(
					`row ${row.id}: searchedCategories must be a non-empty, deduplicated, code-point-ordered list — got ${stringifyJSON(row.searchedCategories)}`
				)
			}
		}

		if (!row.anchorDerivation.trim()) {
			problems.push(`row ${row.id}: anchorDerivation is blank — an anchor nobody can re-derive is an invented one`)
		}

		if (!row.guards.trim()) {
			problems.push(`row ${row.id}: guards is blank`)
		}
	}

	for (const group of ABSENCE_ROW_GROUPS) {
		if (!definition.rows.some((row) => row.group === group)) {
			problems.push(
				`group ${stringifyJSON(group)} has no rows — see the module header for why a one-sided control set decides nothing`
			)
		}
	}

	if (definition.requiredRowHolds !== definition.rows.length) {
		problems.push(
			`requiredRowHolds ${definition.requiredRowHolds} !== ${definition.rows.length} registered rows — this probe asserts a conjunction, and a conjunction with a tolerance is not one`
		)
	}

	return problems
}

/**
 * Load the frozen definition after checking its identity, hash, and audit results.
 */
export async function loadAbsenceProbeDefinition(
	definitionPath: string = ABSENCE_PROBE_DEFINITION_PATH,
	freezePath: string = ABSENCE_PROBE_FREEZE_PATH
): Promise<AbsenceProbeDefinition> {
	return loadFrozenDefinition({
		definitionPath,
		freezePath,
		label: "absence probe",
		idField: "probeID",
		audit: auditAbsenceProbeDefinition,
	})
}

/**
 * Measured result for one row.
 */
export interface AbsenceRowOutcome {
	id: string
	group: AbsenceRowGroup
	query: string
	expectedOutcome: AbsenceExpectedOutcome
	observedOutcome: AbsenceExpectedOutcome
	/**
	 * Whether the outcome and registered category set matched.
	 */
	holds: boolean
	/**
	 * Actual category set searched, when a POI intent formed.
	 */
	searchedCategories?: string[]
	/**
	 * Difference between registered and actual category sets.
	 */
	searchedSetBreach?: string
	/**
	 * Produced observation; omitted for a silent row.
	 */
	observationLine?: string
	/**
	 * POI result, distinguishing no route from abstention or intent.
	 */
	poiOutcome: "none" | "abstain" | "intent"
	abstainReason?: string
	resultsReturned?: number
}

export interface AbsenceCounts {
	rows: number
	holds: number
	targets: number
	targetsFired: number
	controls: number
	controlsSilent: number
}

/**
 * Count outcomes against the complete registered row set.
 */
export function computeAbsenceCounts(
	definition: AbsenceProbeDefinition,
	outcomes: readonly AbsenceRowOutcome[]
): AbsenceCounts {
	const registeredTargets = definition.rows.filter((row) => row.group === "target")

	return {
		rows: definition.rows.length,
		holds: outcomes.filter((outcome) => outcome.holds).length,
		targets: registeredTargets.length,
		targetsFired: outcomes.filter(
			(outcome) => outcome.group === "target" && outcome.observedOutcome === "absence_observation"
		).length,
		controls: definition.rows.length - registeredTargets.length,
		controlsSilent: outcomes.filter(
			(outcome) => outcome.group !== "target" && outcome.observedOutcome !== "absence_observation"
		).length,
	}
}

/**
 * Probe decisions; partial success is a breach.
 */
export const ABSENCE_DECISIONS = ["HOLDS", "BREACHED"] as const

export type AbsenceDecisionOutcome = (typeof ABSENCE_DECISIONS)[number]

export interface AbsenceVerdict {
	decision: AbsenceDecisionOutcome
	counts: AbsenceCounts
	reasons: string[]
	/**
	 * Rows that violate the registered outcome or category set.
	 */
	breaches: string[]
}

/**
 * Decide whether all outcomes satisfy the frozen definition.
 */
export function decideAbsenceProbe(
	definition: AbsenceProbeDefinition,
	outcomes: readonly AbsenceRowOutcome[]
): AbsenceVerdict {
	const counts = computeAbsenceCounts(definition, outcomes)

	const breaches = outcomes
		.filter((outcome) => !outcome.holds)
		.map((outcome) =>
			outcome.observedOutcome === outcome.expectedOutcome && outcome.searchedSetBreach
				? `${outcome.id}: ${outcome.searchedSetBreach}`
				: `${outcome.id}: registered ${outcome.expectedOutcome}, observed ${outcome.observedOutcome}` +
					(outcome.searchedSetBreach ? ` — ${outcome.searchedSetBreach}` : "")
		)

	const reasons = [
		`rows holding their registered outcome ${counts.holds}/${counts.rows} (required ${definition.requiredRowHolds})`,
		`targets carrying the absence observation ${counts.targetsFired}/${counts.targets}`,
		`controls silent ${counts.controlsSilent}/${counts.controls}`,
	]

	return {
		decision: counts.holds === definition.requiredRowHolds && !breaches.length ? "HOLDS" : "BREACHED",
		counts,
		reasons,
		breaches,
	}
}
