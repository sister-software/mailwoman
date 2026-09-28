/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { compareReferential, referentialFromPopulation } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { exactMatchIDs, officialNameIDs } from "#exact-match"
import { foldQueryText } from "#fts/index"
import { populationBoostTerm, type RankingWeights } from "#ranking-weights"
import type { RawSearchRow } from "#search-fetch"
import type { FindPlaceQuery, PlaceCandidate, WOFPlacetype } from "#types"

/**
 * Score one raw FTS row into a `PlaceCandidate`: the weighted sum over the negated BM25
 * baseline, the placetype / country / parent boosts, the length penalty, the proximity
 * and population terms, and the carried fields consumers read.
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

	// SQLite's bm25() is lower-is-better, so negate it to get a higher-is-better baseline.
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

	// Proximity boost applies only when the query carries `near` and the candidate has real coordinates.
	// The decay is tunable via proximityBoost + proximityScaleKm.
	let distanceKm: number | undefined
	// The best decayed-distance term over `near` and every `bias` point wins, each scaled by its weight.
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

	// Population boost caps at `populationBoost` magnitude at `10^populationScaleLog10` people and never penalizes.
	const popTerm = populationBoostTerm(row.population, weights)
	score += popTerm

	// Combined prominence for the exact-tier sort: population and nearness in the same
	// additive units, so hints can win a cross-country postcode tie without a hard filter.
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
		// The referential ranking key is derived as a pure function of this row's population,
		// so it cannot drift from the ordering.
		candidate.referential = referentialFromPopulation(row.population)
	}

	// Carried for consumers (annotations / API surfaces); no ranking site reads it.
	if (row.encyclopedic !== null) {
		candidate.encyclopedic = row.encyclopedic
	}

	// Candidate bbox for parity with the wasm lookup. Without it the Node backend's
	// region→bbox constraint is dead and disambiguation falls to population ranking.
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
 * Order `candidates` in place, exact-match tier first when the extract can answer
 * the name probes, and stamp every candidate's `exactMatch` flag.
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

	// Exact-match tiering ranks a case-folded full match above a partial one,
	// and runs even for a single candidate so `exactMatch` is stamped consistently.
	if (weights.exactMatchTiering && candidates.length) {
		const exactIDs = exactMatchIDs(
			db,
			schemaName,
			candidates.map((c) => c.id as number),
			query.text
		)

		// Stamp the tier onto every candidate so a downstream re-rank's country pin
		// cannot cross the exact/partial boundary.
		for (const c of candidates) {
			c.exactMatch = exactIDs.has(c.id as number)
		}

		if (exactIDs.size) {
			// Within the exact tier, population is the primary key and the score only breaks
			// ties. a name-exact candidate outranks an alias-exact one.
			const needle = foldQueryText(query.text)

			// An official name counts as the place's own name for the sub-tier, floor-conditioned on the holder's population.
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

				if (foldQueryText(String(c.name ?? "")) === needle) return 2

				return officialIDs?.has(c.id as number) ? 2 : 1
			}

			// With proximity hints, prominence replaces raw population as the within-tier key.
			// Without them, referential ordering decides, and encyclopedic importance
			// must not become an input here.
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
