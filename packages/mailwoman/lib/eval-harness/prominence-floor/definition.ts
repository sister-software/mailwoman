/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines and audits the frozen prominence-floor benchmark without loading an engine.
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
 * Their source pools are disjoint.
 */
export const PROMINENCE_STRATA = ["unambiguous", "gold_absent"] as const

/**
 * One registered stratum ID.
 */
export type ProminenceStratum = (typeof PROMINENCE_STRATA)[number]

/**
 * The production-default arm and the four floor arms.
 */
export const PROMINENCE_ARMS = ["default", "floor_1", "floor_2", "floor_3", "floor_4"] as const

/**
 * One registered arm ID.
 */
export type ProminenceArm = (typeof PROMINENCE_ARMS)[number]

/**
 * A population band.
 */
export interface ProminenceBand {
	id: string
	min: number
	/**
	 * The inclusive upper bound.
	 * Zero means the band is unbounded.
	 */
	max: number
}

/**
 * One stratum as the definition file registers it.
 */
export interface ProminenceStratumDefinition {
	id: ProminenceStratum
	purpose: string
	eligibility: string
	query: string
	gold: string
	correctIsAbstention: boolean
}

/**
 * One arm as the definition file registers it.
 */
export interface ProminenceArmDefinition {
	id: ProminenceArm
	description: string
	/**
	 * The pinned `ResolveOpts`.
	 * The default arm omits it.
	 */
	resolveOpts?: { minWinningScore: number }
}

/**
 * The committed prominence-floor benchmark definition.
 */
export interface ProminenceFloorDefinition {
	benchmarkID: string
	version: string
	issue: string
	claim: string
	claimBoundary: string
	whyThisPanel: string
	whyAdminOnly: string
	selectedCandidateRule: string
	goldSource: {
		register: string
		countries: string[]
		whyTheseCountries: string
		license: string
		attribution: string
		baseURL: string
		identity: string
		concordance: string
		identitySetRule: string
		coherenceGuard: string
		excludedRowsNote: string
	}
	populationBands: ProminenceBand[]
	bandRule: string
	sampling: {
		generator: string
		seed: number
		order: string
		rowsPerStratum: number
		minimumRowsPerStratum: number
		underfillRule: string
	}
	strata: ProminenceStratumDefinition[]
	arms: ProminenceArmDefinition[]
	armNote: string
	withheldFixtureFields: {
		fields: string[]
		reason: string
		carriedAnyway: { fields: string[]; reason: string }
	}
	metrics: Array<{ id: string; denominator: string; definition: string }>
	decisionRule: {
		primary: string
		secondary: string
		perBandIsDecisive: string
		comparability: string
		interval: string
		nondeterminism: string
	}
	standingConstraints: string[]
}

/**
 * Path to the committed benchmark definition.
 */
export const PROMINENCE_DEFINITION_PATH = preregistrationPath("prominence-floor", "benchmark-definition.json")

/**
 * Path to the freeze record that holds the definition hash.
 */
export const PROMINENCE_FREEZE_PATH = preregistrationPath("prominence-floor", "benchmark-freeze.json")

/**
 * Finds the band containing a population.
 * It returns `null` for a missing or unmatched population.
 */
export function bandFor(bands: readonly ProminenceBand[], population: number | undefined): ProminenceBand | null {
	if (population === undefined || !Number.isFinite(population)) return null

	return bands.find((band) => population >= band.min && (band.max === 0 || population <= band.max)) ?? null
}

/**
 * Audits the benchmark definition and returns every problem that would block a run.
 */
export function auditProminenceDefinition(definition: ProminenceFloorDefinition): string[] {
	const problems: string[] = [
		...duplicateRowIDProblems(definition.strata),
		...duplicateRowIDProblems(definition.arms),
		...duplicateRowIDProblems(definition.populationBands),
		...samplingProblems(definition.sampling, 100),
		...withheldFieldProblems(definition.withheldFixtureFields.fields, WITHHELD_CANDIDATE_FIELDS),
	]

	const declared = definition.strata.map((stratum) => stratum.id).toSorted(compareByCodePoint)
	const expected = [...PROMINENCE_STRATA].toSorted(compareByCodePoint)

	if (declared.join(",") !== expected.join(",")) {
		problems.push(`strata are ${declared.join(", ")} — the registered set is ${expected.join(", ")}`)
	}

	const armIDs = definition.arms.map((arm) => arm.id).toSorted(compareByCodePoint)
	const expectedArms = [...PROMINENCE_ARMS].toSorted(compareByCodePoint)

	if (armIDs.join(",") !== expectedArms.join(",")) {
		problems.push(`arms are ${armIDs.join(", ")} — the registered set is ${expectedArms.join(", ")}`)
	}

	for (const arm of definition.arms) {
		if (arm.id === "default") {
			if (arm.resolveOpts) {
				problems.push("the default arm pins resolveOpts — then it is not the default path")
			}

			continue
		}

		if (!arm.resolveOpts) {
			problems.push(`arm ${arm.id} pins no minWinningScore — a floor arm that pins nothing is the default arm`)
		}
	}

	const abstentionStrata = definition.strata.filter((stratum) => stratum.correctIsAbstention)

	if (abstentionStrata.length !== 1) {
		problems.push(
			`${abstentionStrata.length} strata register abstention as correct — exactly one does, and it is the withheld-gold stratum`
		)
	}

	// The bands must partition the population range.
	// An overlap counts a row twice, and a gap drops rows before the census can report them.
	const ordered = [...definition.populationBands].toSorted((left, right) => left.min - right.min)

	for (const [index, band] of ordered.entries()) {
		// A row with no recorded population belongs to no band.
		// Bands start at 1 because `readCities` reads an empty population column as zero.
		if (band.min < 1) {
			problems.push(
				`band ${band.id} starts at ${band.min} — a band must start at 1 or above, or an uncounted population enters it as a zero`
			)
		}

		if (band.max !== 0 && band.max < band.min) {
			problems.push(`band ${band.id} runs from ${band.min} to ${band.max} — its ceiling sits below its floor`)
		}

		const next = ordered[index + 1]

		if (next && band.max !== 0 && next.min <= band.max) {
			problems.push(`bands ${band.id} and ${next.id} overlap at ${next.min} — a row would be counted in both`)
		}

		if (next && band.max !== 0 && next.min > band.max + 1) {
			problems.push(
				`bands ${band.id} and ${next.id} leave ${band.max + 1} to ${next.min - 1} in no band — those rows would vanish before the census could report them`
			)
		}

		if (next && band.max === 0) {
			problems.push(`band ${band.id} is unbounded but is not the last band — nothing above it could be reached`)
		}
	}

	if (!definition.metrics.some((metric) => metric.id === "false_selection_rate")) {
		problems.push("no false_selection_rate metric — it is the decision rule's primary quantity")
	}

	return problems
}

/**
 * Loads the frozen definition after checking its identity, hash, and audit.
 */
export async function loadProminenceDefinition(): Promise<ProminenceFloorDefinition> {
	return loadFrozenDefinition<ProminenceFloorDefinition>({
		definitionPath: PROMINENCE_DEFINITION_PATH,
		freezePath: PROMINENCE_FREEZE_PATH,
		label: "prominence-floor benchmark",
		idField: "benchmarkID",
		audit: auditProminenceDefinition,
	})
}
