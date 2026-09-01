/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The score side of the candidate build (#28) — load a WOF admin database's `place_importance` into
 *   a lookup the candidate builder can probe per place, so every candidate row can carry the
 *   toponym-fame prior a bare city name is decided on.
 *
 *   ## Why this joins on the NAME and not on the id
 *
 *   The obvious join is `candidate.spr_id = place_importance.id`, and it is wrong here. The score
 *   source (`admin-global-priority-importance.db`) and the candidate build's admin source are
 *   DIFFERENT SNAPSHOTS, and they disagree about ids for exactly the rows that matter: Whitby,
 *   Ontario is `8143502164401` in the shipped `candidate.db` and `8000001156384` in the score source
 *   — the Overture-sourced rows were re-keyed between the two. An id join silently drops every one of
 *   them, which means it drops precisely the FOREIGN HOMONYMS the fame prior exists to demote, and it
 *   drops them invisibly: the build succeeds, the column is populated, and the ranking is inert on
 *   the queries it was built for.
 *
 *   So the join key is `(name_key, country, placetype)` — the same {@link normalizeLocalityForKey} the
 *   candidate build uses for its probe key, so the two sides fold identically by construction.
 *
 *   ## Why the key alone is not enough
 *
 *   `(warwick, US, locality)` names ELEVEN different places. Taking the group's max would give every
 *   Warwick in America the fame of Warwick, Rhode Island, which is the fan-out defect
 *   `importance-fanout.ts` documents one layer up, re-introduced at the join. So the group is
 *   disambiguated GEOGRAPHICALLY: the nearest centroid wins, and only within
 *   {@link IMPORTANCE_JOIN_GATE_KM}. Two artifacts describing the same settlement put its centroid in
 *   almost the same place; two same-named towns in one country do not.
 *
 *   ## What lands in the column
 *
 *   `place_importance.importance` VERBATIM — the pre-split conflation (encyclopedia-derived where
 *   the concordance matched, a population-derived proxy everywhere else). See
 *   {@link CandidateTable.importance} for why the split `encyclopedic` channel is deliberately NOT
 *   what is written here, with the measurement that settled it.
 *
 *   A place with no match gets NULL. NULL is UNMEASURED, never zero — the consumer
 *   (`resolver/toponym-prior.ts`) leaves an unmeasured candidate exactly where population put it.
 */

import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { CandidateDatabase } from "#candidate-schema"
import { normalizeLocalityForKey } from "#street-normalize"

/**
 * How far apart two artifacts may put the same place's centroid and still be read as the same place.
 *
 * MEASURED, not guessed (2026-08-10, `admin-global-priority.db` × `admin-global-priority-importance.db`; 4,476,245
 * current locality-tier places against 676,790 scored ones, 1,020,099 of which matched a scored group by `(name_key,
 * country, placetype)`). The nearest-centroid distance is **exactly 0.00 km for 577,080 of them (56.6%)** — the two
 * snapshots agree to the bit — and 656,755 (64.4%) are inside 500 m.
 *
 * What sets the gate is where that mode ENDS, and the per-kilometre density states. It falls from 1,076 places/km over
 * 3–5 km to a trough of **441 places/km over 7–10 km**, then climbs back and flattens onto a plateau of 760–780
 * places/km from 30 km out to 100 km and beyond. That plateau is the background rate of two DIFFERENT towns wearing one
 * name in one country, and it does not decay with distance because there is no reason it should. 10 km is the floor
 * between the two populations. Admitting it scores 679,163 places (66.6% of the matched set); pushing the gate to 25 km
 * buys 8,722 more, and by then better than half of each additional kilometre is the wrong town.
 *
 * The four-row bare-GB board is insensitive across this whole range — 5 km and 25 km were both measured and select
 * identical rows — so the value is chosen by what the join MEANS, not by what it scores. The gate is the definition of
 * "this is the same place"; widening it past the floor starts handing one town's fame to another.
 */
export const IMPORTANCE_JOIN_GATE_KM = 10

/**
 * One scored place from the source: where it is, and what it scored.
 */
interface ScoredPlace {
	lat: number
	lon: number
	importance: number
}

/**
 * What {@link loadImportanceIndex} measured while reading the source. Reported by the builder so a run says how much of
 * the gazetteer it actually scored, rather than leaving the caller to infer it from a column full of nulls.
 */
export interface ImportanceIndexStats {
	/**
	 * Scored places read out of the source.
	 */
	places: number
	/**
	 * Distinct `(name_key, country, placetype)` groups they fall into.
	 */
	keys: number
	/**
	 * Places whose name folded to the empty key and could never be joined (non-Latin punctuation-only names, blanks).
	 */
	unkeyable: number
}

/**
 * `(name_key, country, placetype)` → the scored places under it. The separator is U+0000, which no WOF name carries and
 * no fold can produce, so the three fields can't smear into one another.
 */
function groupKey(nameKey: string, country: string | null, placetype: string | null): string {
	return `${nameKey}\u0000${(country ?? "").toUpperCase()}\u0000${placetype ?? ""}`
}

/**
 * A loaded `place_importance`, probed by name + country + placetype + position.
 */
export class ImportanceIndex {
	readonly #groups: Map<string, ScoredPlace[]>
	readonly stats: ImportanceIndexStats
	/**
	 * Places {@link find} matched inside the gate.
	 */
	matched = 0
	/**
	 * Places {@link find} REFUSED — the key matched a scored group, but the nearest member of it was outside the gate, so
	 * it is a different place wearing the same name.
	 *
	 * This is the number worth watching across rebuilds. A jump means the score source and the admin source have drifted
	 * apart and the join is being asked to guess; it does not mean the gate is too tight.
	 */
	gated = 0

	constructor(groups: Map<string, ScoredPlace[]>, stats: ImportanceIndexStats) {
		this.#groups = groups
		this.stats = stats
	}

	/**
	 * The importance of the scored place nearest `(lat, lon)` sharing `name`'s folded key, `country` and `placetype`, or
	 * null when there is no such place within {@link IMPORTANCE_JOIN_GATE_KM}.
	 *
	 * Null is UNMEASURED. Never substitute a zero, and never fall back to a population-derived value here — the source
	 * column already carries that fallback where it has one, and inventing a second one would make an absence
	 * indistinguishable from a measurement.
	 */
	find(name: string, country: string | null, placetype: string | null, lat: number, lon: number): number | null {
		const nameKey = normalizeLocalityForKey(name)

		if (!nameKey) return null

		const group = this.#groups.get(groupKey(nameKey, country, placetype))

		if (!group) return null

		let best: ScoredPlace | undefined
		let bestKm = Infinity

		for (const place of group) {
			const km = haversineKm(lat, lon, place.lat, place.lon)

			if (km < bestKm) {
				bestKm = km
				best = place
			}
		}

		if (!best || bestKm > IMPORTANCE_JOIN_GATE_KM) {
			this.gated++

			return null
		}

		this.matched++

		return best.importance
	}
}

/**
 * Read `place_importance` (joined to `spr` for the name/country/placetype/centroid) out of a WOF admin database into an
 * {@link ImportanceIndex}.
 *
 * Only CURRENT, non-deprecated places are indexed — a superseded row's score belongs to a place the gazetteer no longer
 * carries, and letting it win the nearest-centroid contest would hand a live place a dead one's fame.
 *
 * The whole table is held in memory on purpose. The 2026-08-10 source holds 676,790 scored places in 544,823 groups,
 * and the build probes it once for every one of its ~4.8 M places; the alternative is a prepared statement per place
 * against a 3.7 GB database. Measured end to end, loading the index plus probing all 4.48 M locality-tier places takes
 * 25 s.
 */
export function loadImportanceIndex(databasePath: string): ImportanceIndex {
	using db = new DatabaseClient<CandidateDatabase>(databasePath, { readOnly: true })

	const groups = new Map<string, ScoredPlace[]>()
	let places = 0
	let unkeyable = 0

	for (const row of db
		.prepare(
			`SELECT s.name AS name, s.country AS country, s.placetype AS placetype,
				s.latitude AS latitude, s.longitude AS longitude, i.importance AS importance
			 FROM place_importance i JOIN spr s ON s.id = i.id
			 WHERE s.is_current != 0 AND s.is_deprecated = 0`
		)
		.iterate()) {
		const importance = Number(row.importance)

		if (!Number.isFinite(importance)) continue
		const nameKey = normalizeLocalityForKey(String(row.name ?? ""))

		if (!nameKey) {
			unkeyable++

			continue
		}

		const key = groupKey(nameKey, row.country as string | null, row.placetype as string | null)
		let group = groups.get(key)

		if (!group) {
			group = []
			groups.set(key, group)
		}

		group.push({ lat: Number(row.latitude), lon: Number(row.longitude), importance })

		places++
	}

	return new ImportanceIndex(groups, { places, keys: groups.size, unkeyable })
}
