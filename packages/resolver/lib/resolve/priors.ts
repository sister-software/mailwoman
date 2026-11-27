// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pass 3 of a lookup: the postcode anchor posterior, or the locale prior, importance and capitals.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace } from "@mailwoman/core/resolver"

import type { NodeTraceRecorder, ResolutionState } from "#resolve/passes"
import { promoteSoftCountry, softScopeRetrieves } from "#scope-retrieval"
import { type CapitalLevelFn, promoteCapitals, rankByCountryPrior, rankByImportance } from "#toponym-prior"

/**
 * Ranks a lookup's candidates by its priors in order: the postcode anchor posterior,
 * the ranking-only soft scope, importance with capital promotion, then the retrieval soft scope.
 *
 * `promoted` is the place the retrieval soft scope moved to the lead, or null.
 */
export function rankByPriors(
	candidates: ResolvedPlace[],
	anchorEligible: boolean,
	softCountry: string | null,
	node: AddressNode,
	state: ResolutionState,
	rec: NodeTraceRecorder
): { ranked: ResolvedPlace[]; promoted: ResolvedPlace | null } {
	let ranked = candidates

	// Optional anchor-based rerank using postcode country posterior, kept tier-safe by exact-match first.
	if (state.anchorPosterior && anchorEligible && candidates.length > 1) {
		ranked = rankByAnchorPosterior(candidates, state.anchorPosterior, state.anchorWeight)
		rec.stage("anchor", ranked)
		ranked = rankWithinPosteriorCountry(ranked, state.capitalLevel, node)
		rec.stage("importance", ranked)
	}

	// Without scope retrieval, the soft scope adds to candidate scores ahead of the importance rerank.
	if (softCountry && !softScopeRetrieves(state)) {
		ranked = rankByCountryPrior(ranked, softCountry, state.softCountryWeight)
		rec.stage("locale_prior", ranked)
	}

	// Importance-first rerank (the posterior branch above runs its own, within the winning country).
	if (!state.anchorPosterior) {
		ranked = rankByImportance(ranked)
		rec.stage("importance", ranked)

		// Optional bounded capital promotion.
		if (state.capitalLevel) {
			ranked = promoteCapitalsWithReceipt(ranked, state.capitalLevel, node)
			rec.stage("capital", ranked)
		}
	}

	return promoteSoftCountry(ranked, softCountry, state, rec)
}

/**
 * Sorts candidates by the postcode country posterior, exact matches first.
 *
 * Within a match tier, the key is a candidate's prominence (its score when it has none)
 * plus `weight` times its country's posterior mass.
 * A candidate with no country gets no posterior mass.
 */
function rankByAnchorPosterior<
	T extends Pick<ResolvedPlace, "score" | "country"> & Partial<Pick<ResolvedPlace, "exactMatch" | "prominence">>,
>(candidates: readonly T[], posterior: Readonly<Record<string, number>>, weight: number): T[] {
	const key = (c: T) => (c.prominence ?? c.score) + weight * (c.country ? (posterior[c.country] ?? 0) : 0)

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	return [...candidates].sort(
		(a, b) => Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false) || key(b) - key(a) || b.score - a.score
	)
}

/**
 * Reorders the posterior-ranked leader's peers, the candidates in its country and exact-match
 * tier, by importance and capital promotion, as the path without a posterior ranks them.
 *
 * The posterior decides the country.
 * Within that country this order makes a venue query (`Clayton Post Office, Clayton, WI`)
 * pick the same locality as its bare form (`Clayton, WI`).
 */
function rankWithinPosteriorCountry<
	T extends Pick<ResolvedPlace, "score" | "name" | "country" | "lat" | "lon"> &
		Partial<Pick<ResolvedPlace, "exactMatch" | "importance" | "prominence">>,
>(
	ranked: readonly T[],
	capitalLevel: CapitalLevelFn | null | undefined,
	node: { metadata?: Record<string, unknown> | null }
): T[] {
	const leader = ranked[0]

	if (!leader?.country) return [...ranked]

	const isPeer = (c: T) => c.country === leader.country && (c.exactMatch === true) === (leader.exactMatch === true)
	let peers = rankByImportance(ranked.filter(isPeer))

	if (capitalLevel) {
		peers = promoteCapitalsWithReceipt(peers, capitalLevel, node)
	}

	return [...peers, ...ranked.filter((c) => !isPeer(c))]
}

/**
 * Promote capitals and stamp `capital_promotion` when the leader changes.
 * Metadata only.
 */
function promoteCapitalsWithReceipt<
	T extends Pick<ResolvedPlace, "score" | "name" | "country" | "lat" | "lon"> &
		Partial<Pick<ResolvedPlace, "exactMatch" | "importance" | "prominence">>,
>(ranked: readonly T[], level: CapitalLevelFn, node: { metadata?: Record<string, unknown> | null }): T[] {
	const promoted = promoteCapitals(ranked, level)

	if (promoted[0] !== ranked[0]) {
		node.metadata = { ...node.metadata, capital_promotion: promoted[0]!.country ?? true }
	}

	return promoted
}
