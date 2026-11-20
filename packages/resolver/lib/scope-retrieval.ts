// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Retrieval under a country scope: the soft scope's second fetch, and the probe
 * that finds the same-name places a hard scope excluded.
 *
 * A population-ordered fetch of 5 rows can hold only one country's namesakes.
 * A prior applied after that fetch can't recover a place the fetch's limit left out.
 *
 * The soft scope's country is therefore fetched on its own and merged in.
 */

import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"

import type { NodeTraceRecorder, ResolutionState } from "#resolve/passes"
import { promoteScopedCountry } from "#toponym-prior"

type FindPlaceQuery = Parameters<ResolverBackend["findPlace"]>[0]

/**
 * Whether the soft scope acts inside retrieval: under `scopeCountryRetrieval`,
 * or always for a caller's soft scope.
 *
 * No earlier ranking-only form of the prior served a caller's soft scope.
 */
export function softScopeRetrieves(state: Pick<ResolutionState, "softCountry" | "scopeCountryRetrieval">): boolean {
	return !!state.softCountry && (state.scopeCountryRetrieval || state.softCountry.source === "caller")
}

/**
 * Under scope retrieval, the soft scope's bounded bonus, run after the importance
 * rerank so the rerank can't undo it.
 *
 * `promoted` is the place the bonus moved to the lead, or null when it moved none.
 */
export function promoteSoftCountry(
	ranked: ResolvedPlace[],
	softCountry: string | null,
	state: Pick<ResolutionState, "softCountry" | "scopeCountryRetrieval" | "softCountryWeight" | "capitalLevel">,
	rec: Pick<NodeTraceRecorder, "stage">
): { ranked: ResolvedPlace[]; promoted: ResolvedPlace | null } {
	if (!softCountry || !softScopeRetrieves(state)) return { ranked, promoted: null }

	const promoted = promoteScopedCountry(ranked, softCountry, state.softCountryWeight, state.capitalLevel)

	rec.stage("soft_country_promotion", promoted)

	return { ranked: promoted, promoted: promoted[0] !== ranked[0] ? promoted[0]! : null }
}

/**
 * The places of `first`, then each place of `second` whose id `first` doesn't hold, in their orders.
 */
export function mergeByPlaceID<T extends Pick<ResolvedPlace, "id">>(first: readonly T[], second: readonly T[]): T[] {
	const seen = new Set(first.map((place) => String(place.id)))

	return [...first, ...second.filter((place) => !seen.has(String(place.id)))]
}

/**
 * The candidates of an unscoped lookup merged with the same lookup's rows in the soft scope's `country`.
 */
export async function retrieveWithSoftCountry(
	backend: ResolverBackend,
	query: FindPlaceQuery,
	initial: readonly ResolvedPlace[],
	country: string
): Promise<ResolvedPlace[]> {
	const scoped = await backend.findPlace({ ...query, country })

	return mergeByPlaceID(initial, scoped)
}

/**
 * The same-name places a hard country scope excluded: the lookup run without its country,
 * keeping the rows in another country, each marked `outsideScope`.
 */
export async function placesOutsideCountryScope(
	backend: ResolverBackend,
	query: FindPlaceQuery,
	country: string
): Promise<ResolvedPlace[]> {
	const { country: _scoped, ...unscoped } = query
	const hits = await backend.findPlace(unscoped)
	const target = country.toUpperCase()

	return hits
		.filter((hit) => hit.country?.toUpperCase() !== target)
		.map((hit) => ({ ...hit, outsideScope: true as const }))
}
