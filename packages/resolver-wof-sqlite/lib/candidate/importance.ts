/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The score side of the candidate build: load a WOF admin database's `place_importance` into a
 *   lookup the candidate builder probes per place, so every candidate row can include the
 *   toponym-fame prior a bare city name is decided on.
 *
 *   The join key is `(name_key, country, placetype)`, the same {@link normalizeLocalityForKey} the
 *   candidate build uses for its probe key, so the two sides fold identically. An id join is wrong
 *   here, because the score source (`admin-global-priority-importance.db`) and the candidate build's
 *   admin source are different snapshots whose ids disagree. An id join silently drops rows and
 *   leaves the ranking inert on the queries the prior exists for.
 *
 *   The key by itself is not enough. `(warwick, US, locality)` covers eleven different places.
 *   The group's maximum would give every Warwick in America the fame of Warwick, Rhode Island.
 *   The join picks the nearest centroid when it falls within {@link IMPORTANCE_JOIN_RADIUS_KM}.
 *   Two artifacts describing the same settlement put its centroid
 *   in almost the same place. Two towns with the same name in one country do not.
 *
 *   `place_importance.importance` lands in the column verbatim, the pre-split conflation that is
 *   encyclopedia-derived where the concordance matched and a population-derived proxy everywhere
 *   else. See {@link CandidateTable.importance} for why the split `encyclopedic` channel is not what
 *   is written here.
 *
 *   A place with no match gets NULL. NULL means the place's fame is unmeasured.
 *   The consumer (`resolver/toponym-prior.ts`) leaves an unmeasured candidate at the position
 *   population assigned it.
 */

import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { CandidateDatabase } from "#candidate/schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * How far apart two artifacts may put the same place's centroid and still be read as the same place.
 *
 * Measured from two admin snapshots.
 * The nearest-centroid distances separate into a mode where the two snapshots agree
 * and a background rate of two different towns wearing one name in one country.
 *
 * The background rate does not decay with distance.
 * Ten kilometers separates the two populations.
 *
 * That distance matches the join's purpose.
 * A radius above the floor starts handing one town's fame to another.
 */
export const IMPORTANCE_JOIN_RADIUS_KM = 10

/**
 * One scored place from the source, with its coordinates and importance score.
 */
interface ScoredPlace {
	lat: number
	lon: number
	importance: number
}

/**
 * What {@link loadImportanceIndex} measured while reading the source.
 *
 * Reported by the builder so a run reports how much of the gazetteer it actually scored,
 * rather than leaving the caller to infer it from a column full of nulls.
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
	 * Places whose name folded to the empty key and could never be joined
	 * (non-Latin punctuation-only names, blanks).
	 */
	unkeyable: number
}

/**
 * `(name_key, country, placetype)` → the scored places under it.
 *
 * The separator is U+0000, a character no WOF name contains and no fold can produce,
 * so the three fields cannot smear into one another.
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
	 * Places {@link find} matched inside the radius.
	 */
	matched = 0
	/**
	 * Places {@link find} refused.
	 *
	 * The key matched a scored group, but the nearest member was outside the radius,
	 * so it is a different place wearing the same name.
	 *
	 * This is the number worth watching across rebuilds.
	 * A jump means the score source and the admin source have drifted apart
	 * and the join is being asked to guess.
	 * It does not mean the radius is too tight.
	 */
	refused = 0

	constructor(groups: Map<string, ScoredPlace[]>, stats: ImportanceIndexStats) {
		this.#groups = groups
		this.stats = stats
	}

	/**
	 * The importance of the scored place nearest `(lat, lon)` sharing `name`'s folded key, `country`
	 * and `placetype`, or null when there is no such place within {@link IMPORTANCE_JOIN_RADIUS_KM}.
	 *
	 * Null is unmeasured.
	 * Keep the value null.
	 * Do not substitute zero or a population-derived value here.
	 *
	 * The source column already contains a population-derived fallback where one exists.
	 * A second fallback would make an absence indistinguishable from a measurement.
	 */
	find(name: string, country: string | null, placetype: string | null, lat: number, lon: number): number | null {
		const nameKey = normalizeLocalityForKey(name)

		if (!nameKey) return null

		const group = this.#groups.get(groupKey(nameKey, country, placetype))

		if (!group) return null

		let best: ScoredPlace | null = null
		let bestKm = Infinity

		for (const place of group) {
			const km = haversineKm(lat, lon, place.lat, place.lon)

			if (km < bestKm) {
				bestKm = km
				best = place
			}
		}

		if (!best || bestKm > IMPORTANCE_JOIN_RADIUS_KM) {
			this.refused++

			return null
		}

		this.matched++

		return best.importance
	}
}

/**
 * Read `place_importance` from a WOF admin database and join it to `spr`.
 *
 * The join retrieves each place's name, country, placetype, plus its centroid.
 * These fields populate an {@link ImportanceIndex}.
 *
 * Only current, non-deprecated places are indexed.
 * A superseded row's score belongs to a place the gazetteer no longer contains.
 *
 * If that row won the nearest-centroid contest, a live place would inherit the superseded place's fame.
 *
 * The whole table is held in memory on purpose, because the build probes it once for every place
 * and the alternative is a prepared statement per place against a multi-gigabyte database.
 */
export function loadImportanceIndex(databasePath: PathBuilderLike): ImportanceIndex {
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
