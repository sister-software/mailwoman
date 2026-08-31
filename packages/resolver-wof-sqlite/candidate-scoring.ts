/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How a raw `place_search` row becomes a scored `PlaceCandidate`, and how the resulting pool is
 *   ordered — the weighted-sum score and the exact-match tiering that ranks over it.
 */

import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { exactMatchIDs, officialNameIDs } from "#exact-match"
import { compareReferential, referentialFromPopulation } from "#place-importance-schema"
import type { RankingWeights } from "#ranking-weights"
import type { RawSearchRow } from "#search-fetch"
import type { FindPlaceQuery, PlaceCandidate, WOFPlacetype } from "#types"

/**
 * Score one raw FTS row into a `PlaceCandidate`: the weighted sum over the negated BM25 baseline, the placetype /
 * country / parent boosts, the length penalty, the proximity and population terms, and the carried fields (referential,
 * encyclopedic, bbox) consumers read. `queryLen` is the query text's length, hoisted out of the per-row loop.
 */
export function candidateFromSearchRow(
	row: RawSearchRow,
	context: {
		query: FindPlaceQuery
		placetypes: WOFPlacetype[] | null
		queryLen: number
		weights: RankingWeights
	}
): PlaceCandidate {
	const { query, placetypes, queryLen, weights } = context

	// SQLite's bm25() returns a lower-is-better score (negative for matches). Negate so we
	// start from a higher-is-better baseline.
	let score = -row.rank

	if (placetypes && placetypes.length && placetypes.includes(row.placetype as WOFPlacetype)) {
		score += weights.placetypeMatchBoost
	}

	if (!placetypes && row.placetype === "locality") {
		score += weights.localityImplicitBoost
	}

	if (query.country && row.country === query.country) {
		score += weights.countryMatchBoost
	}

	if (query.parentID !== undefined) {
		score += row.parent_id === query.parentID ? weights.directChildBoost : weights.descendantBoost
	}

	const extraLen = Math.max(0, row.name.length - queryLen - 3)
	score -= (weights.lengthPenaltyWeight * extraLen) / 10

	// Proximity boost: only applied when the query carries `near` AND the candidate has real
	// coordinates. The formula decays smoothly with distance so close-but-not-exact hits
	// still benefit; tunable via proximityBoost + proximityScaleKm.
	let distanceKm: number | undefined
	// The best decayed-distance term over `near` + every `bias` point (each point's term is
	// scaled by its weight; the MAX wins — a candidate near ANY hint is "nearby"). Carried
	// into the exact-tier prominence sort below when hints are present.
	let proximityTerm = 0

	if (row.lat !== null && row.lon !== null && !(row.lat === 0 && row.lon === 0)) {
		const hints: Array<{ lat: number; lon: number; weight: number }> = []

		if (query.near) {
			hints.push({ lat: query.near.lat, lon: query.near.lon, weight: 1 })
		}

		for (const b of query.bias ?? []) {
			hints.push({ lat: b.lat, lon: b.lon, weight: b.weight ?? 1 })
		}

		let scoreTerm = 0

		for (const h of hints) {
			const d = haversineKm(h.lat, h.lon, row.lat, row.lon)
			const decay = h.weight / (1 + d / weights.proximityScaleKm)
			const prom = decay * weights.biasBoost

			if (prom > proximityTerm) {
				proximityTerm = prom
				distanceKm = d
				scoreTerm = decay * weights.proximityBoost
			}
		}

		score += scoreTerm
	}

	// Population boost: capped at `populationBoost` magnitude at `10^populationScaleLog10`
	// people. Missing population → no contribution. Never penalizes.
	let popTerm = 0

	if (row.population !== null && row.population > 0 && weights.populationScaleLog10 > 0) {
		const popLog = Math.log10(1 + row.population)
		const popFraction = Math.min(1, popLog / weights.populationScaleLog10)
		popTerm = weights.populationBoost * popFraction
		score += popTerm
	}

	// Combined prominence for the exact-tier sort when proximity hints are present: population
	// and nearness in the SAME additive units, so the map view / the user's location can win a
	// cross-country postcode tie without a hard filter.
	const prominence = popTerm + proximityTerm

	const candidate: PlaceCandidate = {
		id: row.id,
		prominence,
		name: row.name,
		placetype: row.placetype as WOFPlacetype,
		country: row.country ?? "",
		lat: row.lat ?? 0,
		lon: row.lon ?? 0,
		parent_id: row.parent_id ?? undefined,
		score,
	}

	if (distanceKm !== undefined) {
		candidate.distanceKm = distanceKm
	}

	if (row.population !== null && row.population > 0) {
		candidate.population = row.population
		// The named ranking key (ROAD_TO_V9 §2). DERIVED, not stored — a pure function of the
		// population already on this row, so it cannot drift from what the ordering uses.
		candidate.referential = referentialFromPopulation(row.population)
	}

	// Carried for consumers (annotations / API surfaces). No ranking site reads it.
	if (row.encyclopedic !== null) {
		candidate.encyclopedic = row.encyclopedic
	}

	// Candidate bbox — parity with the WASM lookup (resolver-wof-wasm/lookup.ts), whose
	// consumers (the demo cascade's region constraint) read it. Without this the Node
	// backend's region→bbox constraint is dead and disambiguation falls to population
	// ranking (the Springfield-IL→MO failure the #524 smoke eval caught).
	if (row.min_latitude != null && row.max_latitude != null && row.min_longitude != null && row.max_longitude != null) {
		candidate.bbox = {
			minLat: row.min_latitude,
			maxLat: row.max_latitude,
			minLon: row.min_longitude,
			maxLon: row.max_longitude,
		}
	}

	return candidate
}

/**
 * Order `candidates` IN PLACE — the exact-match tier first when the shard can answer the name probes, otherwise plain
 * weighted-score order. Every candidate is stamped with its `exactMatch` flag on the way through.
 */
export function rankCandidates<DB>(
	candidates: PlaceCandidate[],
	options: {
		db: DatabaseClient<DB>
		schemaName: string
		query: FindPlaceQuery
		weights: RankingWeights
	}
): void {
	const { db, schemaName, query, weights } = options

	// Exact-match tiering: a candidate whose name OR any alias equals the query text (case-folded)
	// ranks above any partial match, with the weighted-sum score (incl. population) breaking ties
	// WITHIN a tier. See the RankingWeights.exactMatchTiering docstring for why this aligns the
	// population prior rather than overriding it. One cheap indexed lookup over the candidate ids.
	// Runs even for a SINGLE candidate so `exactMatch` is stamped consistently (parity with the
	// WASM lookup) — a sole alias hit ("New York City" → New York) must still carry the flag the
	// demo cascade / #369 re-rank read.
	if (weights.exactMatchTiering && candidates.length) {
		const exactIDs = exactMatchIDs(
			db,
			schemaName,
			candidates.map((c) => c.id as number),
			query.text
		)

		// Stamp the tier onto every candidate (not just when the tiering sort fires) so a downstream
		// re-rank — #369's postcode-anchor country pin in `resolveTree` — can keep the country pin from
		// crossing the exact/partial boundary ("ME" → Maine, not the more-populous Missouri).
		for (const c of candidates) {
			c.exactMatch = exactIDs.has(c.id as number)
		}

		if (exactIDs.size) {
			// #905: WITHIN the exact tier, population is the PRIMARY key and the weighted score
			// only breaks population ties. Exactness saturates text relevance, and the bm25
			// residue inside `score` is length-noise (see the fetch-site comment), so letting it
			// order the tier is what sent unscoped "Paris" to an Ohio township. The partial tier
			// keeps score order — text relevance still means something there. This makes the
			// exactMatchTiering docstring literal: match quality primary, prominence within.
			//
			// #912 sub-tier: a NAME-exact candidate (spr.name equals the query) outranks an
			// ALIAS-exact one ('Paris' the place beats 'Paris Township' held via alias 'Paris').
			// The place's own name is a stronger identity claim than an alias — aliases exist to
			// widen recall, not to tie primaries. ME→Maine is untouched: 'ME' name-exact-matches
			// nothing, so the alias sub-tier still decides there. Population orders within each
			// sub-tier as before.
			const norm = (v: string): string => v.toLowerCase().trim().replaceAll(/\s+/g, " ")
			const needle = norm(query.text)

			// #936 option 3: an OFFICIAL name (preferred form in an official language of the place's
			// country, `names.official = 1`) counts as the place's own name for the sub-tier — "Åbo" is
			// Turku's name, not merely its alias. Floor-gated on the holder's population (see the
			// RankingWeights docstring for the measured 100k boundary). officialIDs ⊆ exactIDs by
			// construction (official rows are names rows), so only the sub-tier KIND changes.
			const officialIDs = weights.officialNameExact
				? officialNameIDs(
						db,
						schemaName,
						candidates
							.filter((c) => exactIDs.has(c.id as number) && (c.population ?? 0) >= weights.officialNameExactFloor)
							.map((c) => c.id as number),
						query.text
					)
				: undefined

			const kind = (c: PlaceCandidate): number => {
				if (!exactIDs.has(c.id as number)) return 0

				if (norm(String(c.name ?? "")) === needle) return 2

				return officialIDs?.has(c.id as number) ? 2 : 1
			}

			// With proximity hints (near/bias), prominence (population + nearness, same units)
			// replaces raw population as the within-tier key — the 48026 rule: the map view or
			// the user's location breaks a cross-country postcode tie. Without hints, REFERENTIAL
			// ordering decides.
			//
			// ROAD_TO_V9 §2: this is the site that "orders namesakes", so it is the site that has to
			// say what it orders by. `compareReferential` is referential DESC with raw population as
			// the tiebreak, which is provably the SAME ORDER as the `(b.population ?? 0) - (a.population ?? 0)`
			// it replaces — referential is strictly increasing in population below saturation and
			// constant above it, and the tiebreak restores the order in the saturated tail. Measured
			// zero-delta, not assumed: see `place-importance-schema.test.ts` and `resolver-referential-ranking.test.ts`.
			// Encyclopedic importance is not, and must not become, an input here.
			const hasHints = !!query.near || (query.bias?.length ?? 0) > 0

			candidates.sort((a, b) => {
				const ax = kind(a)
				const bx = kind(b)

				if (bx !== ax) return bx - ax

				if (ax >= 1) {
					if (hasHints) return (b.prominence ?? 0) - (a.prominence ?? 0) || b.score - a.score

					return compareReferential(a, b) || b.score - a.score
				}

				return b.score - a.score
			})

			return
		}
	}

	candidates.sort((a, b) => b.score - a.score)
}
