/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Defines resolution conventions, which are per-polygon profiles merged along a place's ancestor chain.
 *
 *   The strategy implementations live in `lookup.ts` and are registered by name.
 */

import type { FindPlaceQuery, PlaceCandidate } from "#types"

/**
 * Soft-scoring weights for the `postcode_area_resolution` strategy: `pc·S_pc + name·S_name + pop·S_pop`.
 */
export interface ScoringWeights {
	pc: number
	name: number
	pop: number
}

/**
 * A resolution profile attached to a Who's On First admin polygon.
 */
export interface Convention {
	/**
	 * The strategies that the dispatcher runs in order, by registered name.
	 * The first strategy that returns a non-null result wins.
	 */
	candidateStrategies?: string[]
	/**
	 * Weights for the `postcode_area_resolution` soft score.
	 *
	 * A layer may set some weights and inherit the rest from the layers below it.
	 */
	scoringWeights?: Partial<ScoringWeights>
}

/**
 * A convention with every field set, as `resolveConvention` returns it to strategies.
 */
export interface ResolvedConvention {
	candidateStrategies: string[]
	scoringWeights: ScoringWeights
}

/**
 * The base layer that every ancestor chain starts from.
 *
 * It tries `postcode_area_resolution` and then falls back to fuzzy name matching.
 * Every place without a convention override uses these values, so a change here
 * changes resolution in every such country.
 */
export const WORLD_DEFAULT: ResolvedConvention = {
	candidateStrategies: ["postcode_area_resolution", "fallback_fuzzy_name_match"],
	scoringWeights: { pc: 0.6, name: 0.3, pop: 0.1 },
}

/**
 * The names of the strategies that the backend registers.
 *
 * The dispatch registry and the build-time validator share this list, so the build
 * rejects a convention that lists an unknown strategy.
 */
export const BUILTIN_STRATEGY_NAMES = ["postcode_area_resolution", "fallback_fuzzy_name_match"] as const

/**
 * The table name for the convention asset, shared by the build script,
 * the runtime source and extract detection.
 */
export const ADDRESS_CONVENTION_TABLE = "address_convention"

/**
 * A named resolution strategy.
 *
 * @returns `null` to abstain, so the dispatcher tries the next strategy,
 * or an array, possibly empty, to claim the result.
 */
export type Strategy = (query: FindPlaceQuery, convention: ResolvedConvention) => Promise<PlaceCandidate[] | null>

/**
 * Looks up a convention by WOF polygon id.
 * `get` returns `undefined` when the polygon has no override.
 */
export interface ConventionSource {
	get(wofID: number): Convention | undefined
}

/**
 * An in-memory convention source built from a `{ wofID: Convention }` map.
 */
export class SeedConventionSource implements ConventionSource {
	readonly #rows: Map<number, Convention>

	constructor(rows: Record<number, Convention> = {}) {
		this.#rows = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]))
	}

	get(wofID: number): Convention | undefined {
		return this.#rows.get(wofID)
	}
}

/**
 * Merges convention layers, with later, more specific layers winning per field.
 *
 * A layer's `candidateStrategies` replaces the whole list.
 * `scoringWeights` merges key by key, so a layer can change one weight without restating the others.
 */
export function mergeConventions(base: Convention, ...overrides: Array<Convention | undefined>): Convention {
	const out: Convention = {
		candidateStrategies: base.candidateStrategies ? [...base.candidateStrategies] : undefined,
		scoringWeights: base.scoringWeights ? { ...base.scoringWeights } : undefined,
	}

	for (const o of overrides) {
		if (!o) continue

		if (o.candidateStrategies !== undefined) {
			out.candidateStrategies = [...o.candidateStrategies]
		}

		if (o.scoringWeights !== undefined) {
			out.scoringWeights = { ...(out.scoringWeights ?? WORLD_DEFAULT.scoringWeights), ...o.scoringWeights }
		}
	}

	return out
}

/**
 * Resolves the effective convention for a place from its ancestor ids,
 * ordered from most general to most specific.
 *
 * The merge starts from `WORLD_DEFAULT`, so every field is defined.
 */
export function resolveConvention(source: ConventionSource, ancestorIDs: readonly number[]): ResolvedConvention {
	const layers = ancestorIDs.map((id) => source.get(id))
	const merged = mergeConventions(WORLD_DEFAULT, ...layers)

	return {
		candidateStrategies: merged.candidateStrategies ?? WORLD_DEFAULT.candidateStrategies,
		scoringWeights: { ...WORLD_DEFAULT.scoringWeights, ...merged.scoringWeights },
	}
}
