/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines and audits the frozen same-data resolver benchmark.
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
 * The registered strata in fill order.
 * Their eligibility rules keep the pools disjoint.
 */
export const SAME_DATA_STRATA = [
	"unambiguous",
	"homograph_qualified",
	"reordered",
	"contradictory_postcode",
	"gold_absent",
] as const

/**
 * One registered stratum ID.
 */
export type SameDataStratum = (typeof SAME_DATA_STRATA)[number]

/**
 * The registered benchmark arms.
 */
export const SAME_DATA_ARMS = ["mailwoman", "baseline", "ablation"] as const

/**
 * One registered arm ID.
 */
export type SameDataArm = (typeof SAME_DATA_ARMS)[number]

/**
 * One stratum's registered rule.
 *
 * `correctIsAbstention` is true for the stratum whose gold is withheld from the fixture,
 * because that stratum has no correct selection.
 */
export interface SameDataStratumDefinition {
	id: SameDataStratum
	purpose: string
	eligibility: string
	query: string
	gold: string
	correctIsAbstention: boolean
}

/**
 * One arm as the definition file registers it.
 */
export interface SameDataArmDefinition {
	id: SameDataArm
	description: string
	/**
	 * The pinned `ResolveOpts`.
	 * Arms that use library defaults omit it.
	 */
	resolveOpts?: Record<string, boolean>
}

/**
 * One registered metric.
 */
export interface SameDataMetricDefinition {
	id: string
	denominator: string
	definition: string
}

/**
 * The committed same-data benchmark definition.
 */
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
		 * The target rows per stratum.
		 * An underfilled stratum reports its achieved count.
		 */
		rowsPerStratum: number
		/**
		 * The minimum rows a stratum needs to count in the pooled decision.
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
 * Path to the committed benchmark definition.
 */
export const SAME_DATA_DEFINITION_PATH = preregistrationPath("same-data", "benchmark-definition.json")

/**
 * Path to the freeze record that pins the definition hash.
 */
export const SAME_DATA_FREEZE_PATH = preregistrationPath("same-data", "benchmark-freeze.json")

/**
 * Returns the fields the definition withholds from fixtures.
 */
export function withheldFixtureFields(definition: SameDataBenchmarkDefinition): ReadonlySet<string> {
	return new Set(definition.withheldFixtureFields.fields)
}

/**
 * Audits the benchmark definition and returns every problem that would block a run.
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
 * Loads the frozen definition after checking its identity, hash, and audit.
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
