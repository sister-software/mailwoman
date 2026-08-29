/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FROZEN ruler for the absence-observation probe (#1965), and the arithmetic that reads it. Pure —
 *   no model, no database, no pipeline — so every refusal is testable without loading an engine.
 *
 *   WHAT THIS PROBE MEASURES IS AN ASYMMETRY, NOT A DELTA. #1928's ruler compares two arms against a
 *   frozen baseline count. This one asserts a conjunction and its complement: inside exclusion-grade
 *   coverage a pharmacy-affordance answer holding nothing carries an absence observation, and everywhere
 *   else the route is silent. So every row registers a `expectedOutcome` — either `absence_observation` or
 *   one refusal `AbsenceRefusal` names — and the run passes only when every registered row hits the
 *   outcome registered for it. A row that stayed silent for a reason nobody registered fails, even though
 *   it stayed silent.
 *
 *   THE ANCHORS ARE DERIVED FROM THE PILOT LAYER, NOT INVENTED. Each target row names the coverage cell
 *   its anchor resolves into and the `observed_rows` that cell carries. The rows were selected by walking
 *   the pilot layer's own zero-observed cells, taking gazetteer places whose coordinates fall inside one,
 *   and keeping the ones whose resolved search centre lands back in the same cell. No address is written
 *   by hand anywhere in the definition, and a cell centroid is a coordinate — the row's anchor is a place
 *   the gazetteer already carries, not a street line composed to fit.
 *
 *   THE CONTROLS SPLIT THE CONJUNCTION. `outside_coverage` rows put the same query and the same empty
 *   answer outside the surveyed cell set, which is the whole contract: the `[]` there is silence.
 *   `wrong_class` puts a DIFFERENT category at the exact cell a target fires on, so the artifact half of
 *   the conjunction is shown to be required at a cell where the coverage half holds. `cell_populated`
 *   rows sit inside exclusion-grade coverage on cells the layer holds rows in. A control set that could
 *   only fail one way is not a control set.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { sha256Hex } from "@mailwoman/core/utils"
import { existsSync, readFileSync } from "@mailwoman/platform/fs"
import { fileURLToPath } from "@mailwoman/platform/url"

import { ABSENCE_REFUSALS } from "../../observations/index.ts"
// The canonical-JSON encoder is IMPORTED rather than re-typed: two freeze records hashing the same content
// through two encoders would drift at the first key ordering either one changed.
import { canonicalJSON } from "../semantic-utility/probe.ts"

/**
 * The outcome a registered row must produce: the observation, or one named refusal.
 */
export const ABSENCE_EXPECTED_OUTCOMES = ["absence_observation", ...ABSENCE_REFUSALS] as const

export type AbsenceExpectedOutcome = (typeof ABSENCE_EXPECTED_OUTCOMES)[number]

/**
 * The row groups. `target` rows expect the observation; the three control groups expect a named silence.
 */
export const ABSENCE_ROW_GROUPS = ["target", "outside_coverage", "wrong_class", "cell_populated"] as const

export type AbsenceRowGroup = (typeof ABSENCE_ROW_GROUPS)[number]

/**
 * One frozen row.
 */
export interface AbsenceProbeRow {
	id: string
	group: AbsenceRowGroup
	query: string
	locale?: string
	expectedOutcome: AbsenceExpectedOutcome
	/**
	 * Whether this row needs the semantic phrase route injected to reach a category at all. An activity-phrased row
	 * without it never forms a POI intent, which would read as the absence route staying silent when in fact the query
	 * never reached it.
	 */
	requiresSemanticRoute: boolean
	/**
	 * How the anchor was derived — the cell first, the place second. Stated per row so a reader can re-derive it.
	 */
	anchorDerivation: string
	/**
	 * The failure this row would catch.
	 */
	guards: string
}

/**
 * The whole pre-registration, as committed.
 */
export interface AbsenceProbeDefinition {
	probeID: string
	version: string
	issue: string
	claim: string
	asymmetry: string
	/**
	 * The coverage layer the rows were registered against, by filename under `$MAILWOMAN_DATA_ROOT/poi/`. Never an
	 * absolute path: the definition is committed and the data root is per-machine.
	 */
	coverageLayerFile: string
	coverageLayerNote: string
	rows: AbsenceProbeRow[]
	rowsNote: string
	/**
	 * How many registered rows must hit their registered outcome. Equal to the row count: this probe asserts a
	 * conjunction, and a conjunction with a tolerance is not one.
	 */
	requiredRowHolds: number
	decisionRule: string[]
}

/**
 * The freeze record: the definition's identity and the content hash that pins it.
 */
export interface AbsenceProbeFreezeRecord {
	definition: string
	probeID: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

function sourceRelative(name: string): string {
	// `tsc` emits no `.json` into `out/`, so a compiled caller reads the source-tree copy — the same bridge
	// the semantic-utility pre-registration uses.
	const sibling = fileURLToPath(new URL(name, import.meta.url))

	if (existsSync(sibling)) return sibling

	return fileURLToPath(new URL(`../../../eval-harness/absence-observation/${name}`, import.meta.url))
}

/**
 * The committed pre-registration.
 */
export const ABSENCE_PROBE_DEFINITION_PATH = sourceRelative("probe-definition.json")

/**
 * The committed freeze record for it.
 */
export const ABSENCE_PROBE_FREEZE_PATH = sourceRelative("probe-freeze.json")

/**
 * The content hash of one definition.
 */
export function absenceProbeDefinitionHash(definition: AbsenceProbeDefinition): string {
	return sha256Hex(canonicalJSON(definition))
}

/**
 * Everything that must be true of a definition, checked without running anything. One message per problem, each naming
 * the field or row id. Empty means the definition is executable.
 */
export function auditAbsenceProbeDefinition(definition: AbsenceProbeDefinition): string[] {
	const problems: string[] = []

	if (!definition.rows.length) {
		problems.push("rows is empty — a probe with no row measures nothing")
	}

	const seen = new Set<string>()

	for (const row of definition.rows) {
		if (seen.has(row.id)) {
			problems.push(`row id ${JSON.stringify(row.id)} is used twice — ids name rows in output`)
		}

		seen.add(row.id)

		if (!(ABSENCE_ROW_GROUPS as readonly string[]).includes(row.group)) {
			problems.push(`row ${row.id}: group ${JSON.stringify(row.group)} is not a registered group`)
		}

		if (!(ABSENCE_EXPECTED_OUTCOMES as readonly string[]).includes(row.expectedOutcome)) {
			problems.push(`row ${row.id}: expectedOutcome ${JSON.stringify(row.expectedOutcome)} is not a registered outcome`)
		}

		if (row.group === "target" && row.expectedOutcome !== "absence_observation") {
			problems.push(
				`row ${row.id}: a target row expects ${JSON.stringify(row.expectedOutcome)} — a target that does not expect the observation measures nothing about the route firing`
			)
		}

		if (row.group !== "target" && row.expectedOutcome === "absence_observation") {
			problems.push(
				`row ${row.id}: a ${row.group} control expects the observation — the control groups exist to assert silence`
			)
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
				`group ${JSON.stringify(group)} has no rows — see the module header for why a one-sided control set decides nothing`
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
 * Load the frozen pre-registration, refusing anything that would let the ruler move.
 *
 * Three refusals, in order: the freeze record must name this definition and version, the definition's content hash must
 * equal the frozen hash, and the audit must be clean. A caller never receives a definition it may only partly trust.
 */
export function loadAbsenceProbeDefinition(
	definitionPath: string = ABSENCE_PROBE_DEFINITION_PATH,
	freezePath: string = ABSENCE_PROBE_FREEZE_PATH
): AbsenceProbeDefinition {
	const definition = parseJSONStrict<AbsenceProbeDefinition>(readFileSync(definitionPath, "utf8"))
	const freeze = parseJSONStrict<AbsenceProbeFreezeRecord>(readFileSync(freezePath, "utf8"))

	if (freeze.probeID !== definition.probeID) {
		throw new Error(
			`absence probe: freeze record names probe ${JSON.stringify(freeze.probeID)}, definition is ${JSON.stringify(definition.probeID)}`
		)
	}

	if (freeze.version !== definition.version) {
		throw new Error(
			`absence probe: freeze record pins version ${freeze.version}, definition is ${definition.version} — a definition change bumps BOTH the version and the hash`
		)
	}

	const observed = absenceProbeDefinitionHash(definition)

	if (observed !== freeze.sha256) {
		throw new Error(
			`absence probe: definition content hash ${observed} !== frozen ${freeze.sha256} — the ruler moved. Restore it, or record a new version and hash in ${freeze.definition}`
		)
	}

	const problems = auditAbsenceProbeDefinition(definition)

	if (problems.length) {
		throw new Error(
			["absence probe: the pre-registration is not executable:", ...problems.map((p) => `  - ${p}`)].join("\n")
		)
	}

	return definition
}

/**
 * One row's measured outcome.
 */
export interface AbsenceRowOutcome {
	id: string
	group: AbsenceRowGroup
	query: string
	expectedOutcome: AbsenceExpectedOutcome
	observedOutcome: AbsenceExpectedOutcome
	holds: boolean
	/**
	 * The observation the row produced, when it produced one. Absent — the key omitted — on a silent row.
	 */
	observationLine?: string
	/**
	 * Whether the POI branch answered at all, and with what — carried so a silent row can be told apart from a row whose
	 * query never reached the POI branch.
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
 * Count one run.
 *
 * The denominators are the REGISTERED row counts, never the rows that happened to answer, so a probe that stops being
 * able to read a row reports a lower hold count rather than a smaller board.
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
 * The two decisions this probe admits. There is no middle: the asymmetry either holds over every registered row or it
 * does not, and a partial asymmetry is a route that fires somewhere nobody registered.
 */
export const ABSENCE_DECISIONS = ["HOLDS", "BREACHED"] as const

export type AbsenceDecisionOutcome = (typeof ABSENCE_DECISIONS)[number]

export interface AbsenceVerdict {
	decision: AbsenceDecisionOutcome
	counts: AbsenceCounts
	reasons: string[]
	/**
	 * Every row whose observed outcome differs from its registered one, named.
	 */
	breaches: string[]
}

/**
 * Map measured outcomes onto exactly one decision, against the frozen row set.
 */
export function decideAbsenceProbe(
	definition: AbsenceProbeDefinition,
	outcomes: readonly AbsenceRowOutcome[]
): AbsenceVerdict {
	const counts = computeAbsenceCounts(definition, outcomes)

	const breaches = outcomes
		.filter((outcome) => !outcome.holds)
		.map((outcome) => `${outcome.id}: registered ${outcome.expectedOutcome}, observed ${outcome.observedOutcome}`)

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
