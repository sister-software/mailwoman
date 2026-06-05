/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The **Geographic Rule Engine** convention model (Direction E, #289 — see
 *   `docs/articles/plan/2026-06-05-geographic-rule-engine.md` and epic #288).
 *
 *   A `Convention` is a declarative resolution profile attached to a Who's-On-First admin polygon.
 *   The engine deep-merges the conventions along a resolved place's ancestor chain — country →
 *   region → … → locality, most-specific winning — and the backend dispatches the named strategies
 *   in `candidateStrategies`, first to return candidates wins.
 *
 *   This module is the backend-agnostic core: the convention TYPES, the deep-merge, and the seed
 *   source. The strategy IMPLEMENTATIONS are SQL-bound and live in `lookup.ts`, registered by
 *   name.
 *
 *   For the existing EU locales (DE/FR/GB/NL) the seed source is empty, so every query resolves to
 *   `WORLD_DEFAULT` and the dispatch is byte-identical to the pre-engine coordinate-first path. JP
 *   / KR / TW add rows here (and #290 swaps the seed map for a build-from-source sqlite-backed
 *   source).
 */

import type { FindPlaceQuery, PlaceCandidate } from "./types.js"

/**
 * Soft-scoring weights for the `postcode_area_resolution` strategy: `pc·S_pc + name·S_name +
 * pop·S_pop`.
 */
export interface ScoringWeights {
	pc: number
	name: number
	pop: number
}

/**
 * A geographically-scoped resolution profile. Namespaced sections grow per phase; #289 ships the
 * dispatch + scoring slice (`candidateStrategies` + `scoringWeights`). Later phases add
 * `fieldMapping` (locale semantics for `locator[]`), `tokenNormalization`, etc.
 */
export interface Convention {
	/** Ordered strategy names the dispatcher runs; the first to return a non-null result wins. */
	candidateStrategies?: string[]
	/**
	 * Weights for `postcode_area_resolution`'s soft-score. Partial — a layer may nudge one weight and
	 * inherit the rest from the layers below it (`resolveConvention` fills any gaps from
	 * WORLD_DEFAULT).
	 */
	scoringWeights?: Partial<ScoringWeights>
}

/**
 * A fully-resolved convention: every field present, weights complete. What `resolveConvention`
 * returns and what strategies consume.
 */
export interface ResolvedConvention {
	candidateStrategies: string[]
	scoringWeights: ScoringWeights
}

/**
 * The base layer every ancestor chain starts from. Reproduces the pre-engine coordinate-first
 * behavior exactly: try `postcode_area_resolution`, else fall back to fuzzy name match; soft-score
 * weights 0.6 / 0.3 / 0.1. Changing these changes EU behavior — don't, without a byte-stability
 * run.
 */
export const WORLD_DEFAULT: ResolvedConvention = {
	candidateStrategies: ["postcode_area_resolution", "fallback_fuzzy_name_match"],
	scoringWeights: { pc: 0.6, name: 0.3, pop: 0.1 },
}

/**
 * The strategy names the backend registers. The single source of truth shared by the dispatch
 * registry and the build-time validator, so an authored convention that names a non-existent
 * strategy is caught at build (loud) rather than silently skipped at runtime.
 */
export const BUILTIN_STRATEGY_NAMES = ["postcode_area_resolution", "fallback_fuzzy_name_match"] as const

/**
 * Table name for the convention asset (#290). Carried here so the build script, the runtime source,
 * and the shard auto-detect all agree.
 */
export const ADDRESS_CONVENTION_TABLE = "address_convention"

/**
 * A named resolution primitive. Returns `null` to abstain (gate unmet / no data) → the dispatcher
 * tries the next strategy; returns an array (possibly empty) to claim the result.
 */
export type Strategy = (query: FindPlaceQuery, convention: ResolvedConvention) => Promise<PlaceCandidate[] | null>

/**
 * Look up a convention record by WOF polygon id. Returns `undefined` when the polygon has no
 * override.
 */
export interface ConventionSource {
	get(wofId: number): Convention | undefined
}

/**
 * In-memory convention source seeded from a `{ wofId: Convention }` map. Empty for the EU locales
 * (they ride `WORLD_DEFAULT`); JP / KR / TW add rows. #290 replaces this with a sqlite-backed
 * source built from source, same distributable-asset discipline as `postcode-locality-intl.db`.
 */
export class SeedConventionSource implements ConventionSource {
	readonly #rows: Map<number, Convention>

	constructor(rows: Record<number, Convention> = {}) {
		this.#rows = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]))
	}

	get(wofId: number): Convention | undefined {
		return this.#rows.get(wofId)
	}
}

/**
 * Deep-merge convention layers, later (more-specific) layers winning per field.
 * `candidateStrategies` is replaced wholesale — a convention names its full ordered list, it does
 * not append. `scoringWeights` is merged key-by-key so a locality can nudge one weight without
 * restating the others.
 */
export function mergeConventions(base: Convention, ...overrides: Array<Convention | undefined>): Convention {
	const out: Convention = {
		candidateStrategies: base.candidateStrategies ? [...base.candidateStrategies] : undefined,
		scoringWeights: base.scoringWeights ? { ...base.scoringWeights } : undefined,
	}
	for (const o of overrides) {
		if (!o) continue
		if (o.candidateStrategies !== undefined) out.candidateStrategies = [...o.candidateStrategies]
		if (o.scoringWeights !== undefined) {
			out.scoringWeights = { ...(out.scoringWeights ?? WORLD_DEFAULT.scoringWeights), ...o.scoringWeights }
		}
	}
	return out
}

/**
 * Resolve the effective convention for a place given its ancestor chain, ordered MOST-GENERAL →
 * MOST-SPECIFIC (country, region, …, locality). Starts from `WORLD_DEFAULT` so every field is
 * defined regardless of which (if any) ancestors carry an override.
 */
export function resolveConvention(source: ConventionSource, ancestorIds: readonly number[]): ResolvedConvention {
	const layers = ancestorIds.map((id) => source.get(id))
	const merged = mergeConventions(WORLD_DEFAULT, ...layers)
	return {
		candidateStrategies: merged.candidateStrategies ?? WORLD_DEFAULT.candidateStrategies,
		// Fill any weight gaps from the base so strategies always see a complete set.
		scoringWeights: { ...WORLD_DEFAULT.scoringWeights, ...merged.scoringWeights },
	}
}
