/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The frozen ruler for the prominence-floor benchmark (#2264), and the audit that refuses an unexecutable
 *   one. Pure — no model, no database, no resolver — so every refusal is testable without loading an engine.
 *
 *   It exists because the same-data benchmark measured `minWinningScore` and could not interpret the answer.
 *   Every one of that panel's 453 gold entities carries population above 15,151, so a floor of 4.0 — which is
 *   a population floor of 10,000 — admits every correct answer it contains by construction. A panel whose
 *   gold all clears a floor cannot measure that floor, whatever the rate says.
 *
 *   So the population BAND is the unit here, and the decision is stated per band rather than pooled: pooling
 *   is the operation that hid the confound the first time. A floor that wins pooled while losing a band fails
 *   this claim.
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
 * The two registered strata, in fill order. They draw from disjoint geonameid pools, so the withheld-gold rows are
 * never the rows whose gold was also graded present.
 */
export const PROMINENCE_STRATA = ["unambiguous", "gold_absent"] as const

export type ProminenceStratum = (typeof PROMINENCE_STRATA)[number]

/**
 * The registered arms: the production defaults, and the four floors.
 */
export const PROMINENCE_ARMS = ["default", "floor_1", "floor_2", "floor_3", "floor_4"] as const

export type ProminenceArm = (typeof PROMINENCE_ARMS)[number]

export interface ProminenceBand {
	id: string
	min: number
	/**
	 * Zero means unbounded. A band is `min <= population <= max`, and a row with no recorded population is in no band —
	 * absence of a count is not a count of zero.
	 */
	max: number
}

export interface ProminenceStratumDefinition {
	id: ProminenceStratum
	purpose: string
	eligibility: string
	query: string
	gold: string
	correctIsAbstention: boolean
}

export interface ProminenceArmDefinition {
	id: ProminenceArm
	description: string
	/**
	 * The `ResolveOpts` the arm pins. Absent on the default arm, where an empty object and "the defaults" would be
	 * indistinguishable in the record.
	 */
	resolveOpts?: { minWinningScore: number }
}

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
 * The committed ruler: the population bands, the two selection rules, the arm floors, the sampling seed and the
 * decision rule. Named from the package root because `tsc` emits no `.json` into `out/`.
 */
export const PROMINENCE_DEFINITION_PATH = preregistrationPath("prominence-floor", "benchmark-definition.json")

/**
 * The freeze record pinning that ruler's content hash. A definition change bumps both the version and this hash.
 */
export const PROMINENCE_FREEZE_PATH = preregistrationPath("prominence-floor", "benchmark-freeze.json")

/**
 * The population band a count falls in, or null when it falls in none. A row with no recorded population reaches here
 * as `undefined` and is refused rather than bucketed at zero.
 */
export function bandFor(bands: readonly ProminenceBand[], population: number | undefined): ProminenceBand | null {
	if (population === undefined || !Number.isFinite(population)) return null

	return bands.find((band) => population >= band.min && (band.max === 0 || population <= band.max)) ?? null
}

/**
 * Whether the benchmark is executable as written. Each problem names what a runner could not do with the definition, so
 * a refusal reads as an instruction rather than a verdict.
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

	// The bands must partition rather than overlap: a row in two bands would be counted twice under a claim stated per
	// band, and the disjoint-pool rule could not hold.
	const ordered = [...definition.populationBands].toSorted((left, right) => left.min - right.min)

	for (const [index, band] of ordered.entries()) {
		// `bandRule` registers that a row with no recorded population is in NO band. `bandFor` enforces that by refusing
		// `undefined`, but a band starting at 0 would admit a row the register counted as zero, which is the same
		// absence wearing a number — and the reader `readCities` supplies turns an empty column into exactly that.
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

		// A gap is as wrong as an overlap and is harder to see: the rows falling in it are filtered out before a stratum
		// counts its eligible pool, so the census reports nothing missing.
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
 * Load the frozen benchmark definition, refusing anything that would let the ruler move: the freeze record must name
 * this benchmark and version, the content hash must equal the frozen hash, and the audit must be clean.
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
