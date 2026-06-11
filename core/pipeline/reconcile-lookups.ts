/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pre-fetch adapters that wire a `ResolverBackend` into the reconciler's concordance axes (#478
 *   step 2, re-scoped): `reconcileSpans` already implements resolver-candidate and parent-chain
 *   scoring but the runtime pipeline never passed the lookups — the axes were dormant, exercised
 *   only by Map-backed test fixtures.
 *
 *   The reconciler's beam search is SYNCHRONOUS; the backend is async. So this module does one
 *   bounded async pre-fetch pass — `findPlace` per (phrase-span × top-k tag) pair, `ancestors` per
 *   fetched place — and returns Map-backed lookups with the contract the reconciler expects. Query
 *   count is capped (`maxLookups`, default 12) the same way `resolveTree` caps its walk; pairs are
 *   visited in classifier-score order so the budget goes to the likeliest spans.
 */

import type { ResolvedPlace, ResolverBackend } from "../resolver/types.js"
import type { ClassifierCandidate, ParentChainLookup, ResolverCandidatesLookup } from "./reconcile.js"

const RESOLVABLE_TAGS = new Set(["country", "region", "locality", "dependent_locality", "county", "subregion"])

export interface ReconcileLookups {
	resolverCandidates: ResolverCandidatesLookup
	parentChain: ParentChainLookup
}

/**
 * Build the reconciler's concordance lookups from one bounded pre-fetch pass over the backend.
 *
 * @param backend The gazetteer backend (Stage 6's `WofSqlitePlaceLookup.asResolverBackend()` in
 *   production; any structural match in tests).
 * @param raw The normalized input text — span bounds index into this.
 * @param classifierTopK The aggregated per-span tag candidates (score-descending preferred; the
 *   budget follows this order).
 * @param opts.maxLookups Hard cap on `findPlace` calls (default 12).
 * @param opts.candidatesPerPair Max places retained per (span, tag) pair (default 3).
 */
export async function prefetchReconcileLookups(
	backend: ResolverBackend,
	raw: string,
	classifierTopK: ReadonlyArray<ClassifierCandidate>,
	opts?: { maxLookups?: number; candidatesPerPair?: number; defaultCountry?: string }
): Promise<ReconcileLookups> {
	const maxLookups = opts?.maxLookups ?? 12
	const perPair = opts?.candidatesPerPair ?? 3

	const candidateTable = new Map<string, ResolvedPlace[]>()
	const chainTable = new Map<number | string, ResolvedPlace[]>()
	const pairKey = (span: { start: number; end: number }, tag: string) => `${span.start}:${span.end}:${tag}`

	let budget = maxLookups
	for (const candidate of classifierTopK) {
		if (budget <= 0) break
		if (!RESOLVABLE_TAGS.has(candidate.tag)) continue
		const key = pairKey(candidate.span, candidate.tag)
		if (candidateTable.has(key)) continue
		const text = raw.slice(candidate.span.start, candidate.span.end).trim()
		if (!text) continue
		budget--
		let places: ResolvedPlace[] = []
		try {
			places = await backend.findPlace({
				text,
				placetype: candidate.tag,
				...(opts?.defaultCountry ? { country: opts.defaultCountry } : {}),
				limit: perPair,
			})
		} catch {
			// A backend failure degrades to "no concordance evidence for this pair" — the
			// reconciler scores without it, identical to today's behavior.
		}
		candidateTable.set(key, places.slice(0, perPair))

		// Ancestors are synchronous + memoized backend-side; chain them now so parentsOf is a
		// pure Map read during the beam search.
		if (backend.ancestors) {
			for (const place of places) {
				if (chainTable.has(place.id)) continue
				const chain = backend.ancestors(place.id) ?? []
				// The reconciler's concordance check is MEMBERSHIP-ONLY (by id) — Ancestor carries no
				// coordinates, and none are needed; zeroes satisfy the ResolvedPlace shape.
				chainTable.set(
					place.id,
					chain.map((a) => ({ id: a.id, name: a.name, placetype: a.placetype, lat: 0, lon: 0 }) as ResolvedPlace)
				)
			}
		}
	}

	return {
		resolverCandidates: {
			candidatesFor(span, tag) {
				return candidateTable.get(pairKey(span, tag)) ?? []
			},
		},
		parentChain: {
			parentsOf(place) {
				return chainTable.get(place.id) ?? []
			},
		},
	}
}
