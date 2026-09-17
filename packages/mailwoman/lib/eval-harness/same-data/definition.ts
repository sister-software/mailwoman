/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen ruler for the same-data resolver benchmark (#2261), and the audit that refuses an
 *   unexecutable one. Pure — no model, no database, no resolver — so every refusal is testable without
 *   loading an engine.
 *
 *   The strata are defined by selection rules rather than by listed rows, and a rule editable after a result
 *   is visible asserts nothing: the rule that produced the losing panel can be rewritten into the one that
 *   produces the winning panel. The content hash pins the rules, the sampling seed and the decision rule
 *   together, so a rebuilt panel is the panel that was scored.
 *
 *   The benchmark is admin-only because `resolveTree` picks a place per node, and the rooftop tier answers
 *   through `AddressPointLookup` / `InterpolationLookup` / `StreetCentroidLookup`, each returning one hit or
 *   null. `ResolverBackend.findPlace` is the only interface in the ladder returning a candidate set, so it
 *   is the only layer where "same evidence, different selection" describes the code rather than two indexes.
 */

import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import {
	duplicateRowIDProblems,
	loadFrozenDefinition,
	preregistrationPath,
	samplingProblems,
	withheldFieldProblems,
} from "#eval-harness/preregistration"
import { WITHHELD_CANDIDATE_FIELDS } from "#eval-harness/same-data/fixture"

/**
 * The five registered strata, in fill order. Order is meaningful: strata draw from disjoint geonameid pools, and a
 * later stratum's eligibility rule excludes every row an earlier one took.
 */
export const SAME_DATA_STRATA = [
	"unambiguous",
	"homograph_qualified",
	"reordered",
	"contradictory_postcode",
	"gold_absent",
] as const

export type SameDataStratum = (typeof SAME_DATA_STRATA)[number]

/**
 * The three registered arms.
 */
export const SAME_DATA_ARMS = ["mailwoman", "baseline", "ablation"] as const

export type SameDataArm = (typeof SAME_DATA_ARMS)[number]

/**
 * One stratum's registered rule. `correctIsAbstention` is the only per-stratum scoring difference, and it exists
 * because a stratum whose gold is withheld from the fixture has no correct SELECTION by construction.
 */
export interface SameDataStratumDefinition {
	id: SameDataStratum
	purpose: string
	eligibility: string
	query: string
	gold: string
	correctIsAbstention: boolean
}

export interface SameDataArmDefinition {
	id: SameDataArm
	description: string
	/**
	 * The `ResolveOpts` the arm pins. Present on the ablation arm; absent on the arms that run library defaults, where an
	 * empty object and "the defaults" would be indistinguishable.
	 */
	resolveOpts?: Record<string, boolean>
}

export interface SameDataMetricDefinition {
	id: string
	denominator: string
	definition: string
}

export interface SameDataBenchmarkDefinition {
	benchmarkID: string
	version: string
	issue: string
	claim: string
	claimBoundary: string
	whyAdminOnly: string
	selectedCandidateRule: string
	goldSource: {
		register: string
		license: string
		attribution: string
		baseURL: string
		identity: string
		postalRegister: string
		concordance: string
		excludedRowsNote: string
	}
	sampling: {
		generator: string
		seed: number
		order: string
		/**
		 * The TARGET row count per stratum. A stratum whose eligible pool cannot reach it is reported at its achieved n.
		 */
		rowsPerStratum: number
		/**
		 * Below this, a stratum is reported and excluded from the pooled decision.
		 */
		minimumRowsPerStratum: number
		underfillRule: string
	}
	strata: SameDataStratumDefinition[]
	arms: SameDataArmDefinition[]
	withheldFixtureFields: {
		fields: string[]
		reason: string
		carriedAnyway: { fields: string[]; reason: string }
	}
	metrics: SameDataMetricDefinition[]
	decisionRule: {
		primary: string
		secondary: string
		perStratumIsDescriptive: string
		interval: string
		nondeterminism: string
	}
	standingConstraints: string[]
}

/**
 * The committed ruler: the claim boundary, the five selection rules, the sampling seed and the decision rule. Named
 * from the package root because `tsc` emits no `.json` into `out/`.
 */
export const SAME_DATA_DEFINITION_PATH = preregistrationPath("same-data", "benchmark-definition.json")

/**
 * The freeze record pinning that ruler's content hash. A definition change bumps both the version and this hash.
 */
export const SAME_DATA_FREEZE_PATH = preregistrationPath("same-data", "benchmark-freeze.json")

/**
 * The fields a fixture must not carry, read from the frozen definition rather than re-typed here: a second copy of the
 * list would let the fixture builder and the ruler disagree about what equal evidence means.
 */
export function withheldFixtureFields(definition: SameDataBenchmarkDefinition): ReadonlySet<string> {
	return new Set(definition.withheldFixtureFields.fields)
}

/**
 * Whether the benchmark is executable as written. Each problem names what a runner could not do with the definition, so
 * a refusal reads as an instruction rather than a verdict.
 */
export function auditSameDataDefinition(definition: SameDataBenchmarkDefinition): string[] {
	const problems: string[] = [...duplicateRowIDProblems(definition.strata), ...duplicateRowIDProblems(definition.arms)]

	const declared = definition.strata.map((stratum) => stratum.id).toSorted(compareByCodePoint)
	const expected = [...SAME_DATA_STRATA].toSorted(compareByCodePoint)

	if (declared.join(",") !== expected.join(",")) {
		problems.push(`strata are ${declared.join(", ")} — the registered set is ${expected.join(", ")}`)
	}

	const armIDs = definition.arms.map((arm) => arm.id).toSorted(compareByCodePoint)
	const expectedArms = [...SAME_DATA_ARMS].toSorted(compareByCodePoint)

	if (armIDs.join(",") !== expectedArms.join(",")) {
		problems.push(`arms are ${armIDs.join(", ")} — the registered set is ${expectedArms.join(", ")}`)
	}

	const ablation = definition.arms.find((arm) => arm.id === "ablation")

	if (ablation && !ablation.resolveOpts) {
		problems.push("the ablation arm declares no resolveOpts — an ablation that pins nothing is the production arm")
	}

	for (const [option, value] of Object.entries(ablation?.resolveOpts ?? {})) {
		if (value !== false) {
			problems.push(`ablation option ${option} is pinned to ${String(value)} — every ablated option is pinned off`)
		}
	}

	problems.push(...samplingProblems(definition.sampling, 100))

	const abstentionStrata = definition.strata.filter((stratum) => stratum.correctIsAbstention)

	if (abstentionStrata.length !== 1) {
		problems.push(
			`${abstentionStrata.length} strata register abstention as correct — exactly one does, and it is the withheld-gold stratum`
		)
	}

	if (!definition.metrics.some((metric) => metric.id === "candidate_selection_accuracy")) {
		problems.push("no candidate_selection_accuracy metric — it is the decision rule's primary quantity")
	}

	problems.push(...withheldFieldProblems(definition.withheldFixtureFields.fields, WITHHELD_CANDIDATE_FIELDS))

	return problems
}

/**
 * Load the frozen benchmark definition, refusing anything that would let the ruler move: the freeze record must name
 * this benchmark and version, the content hash must equal the frozen hash, and the audit must be clean.
 */
export async function loadSameDataDefinition(): Promise<SameDataBenchmarkDefinition> {
	return loadFrozenDefinition<SameDataBenchmarkDefinition>({
		definitionPath: SAME_DATA_DEFINITION_PATH,
		freezePath: SAME_DATA_FREEZE_PATH,
		label: "same-data benchmark",
		idField: "benchmarkID",
		audit: auditSameDataDefinition,
	})
}
