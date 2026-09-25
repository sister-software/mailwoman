/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Maps GeoNames gold entities to sets of WOF IDs through the WOF concordance table.
 *
 *   The benchmark grades by identity through this join because distance cannot tell two nearby
 *   same-named places apart. A GeoNames ID can map to several city-tier WOF rows, so the gold is a set of
 *   IDs. The join admits a set only when every member passes the name, country, and distance checks in
 *   {@link readGoldSets}.
 */

import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"
import type { PathBuilderLike } from "path-ts"

/**
 * The concordance source key WOF writes for a GeoNames identifier.
 */
const GEONAMES_SOURCE = "gn:id"

/**
 * WOF placetypes at the city tier of a `cities15000.txt` row.
 *
 * WOF splits the city tier between `locality` and `localadmin`.
 */
const CITY_TIER = new Set(["locality", "localadmin"])

/**
 * The maximum distance in kilometres between a concorded WOF row and the register's coordinate.
 *
 * It equals the benchmark's registered wrong-area threshold.
 */
export const GOLD_COHERENCE_KM = 25

/**
 * Identifiers per `IN` clause.
 *
 * The value stays under SQLite's default limit of 999 host parameters.
 * Chunking keeps the filter in SQL, which avoids loading about two million `gn:id` rows into JavaScript.
 */
const IDENTIFIERS_PER_QUERY = 900

/**
 * The columns this module reads from the WOF admin gazetteer.
 *
 * The DDL lives in the unified schema of `@mailwoman/resolver-wof-sqlite`.
 */
interface WOFGazetteerDatabase {
	concordances: {
		id: number
		other_id: string
		other_source: string
		lastmodified: number
	}
	spr: {
		id: number
		parent_id: number
		name: string
		placetype: string
		country: string
		latitude: number
		longitude: number
	}
}

interface ConcordanceRow {
	other_id: string
	id: number
	placetype: string
	name: string
	country: string
	latitude: number
	longitude: number
}

/**
 * The fields of a GeoNames register row that the gold-set checks read.
 */
export interface GoldSubject {
	geonameid: string
	name: string
	asciiname: string
	country: string
	lat: number
	lon: number
}

/**
 * Counts of subjects by the check that excluded them, plus the coherent count.
 *
 * Each exclusion count describes a separate gazetteer gap, so the report keeps them apart.
 */
export interface GoldCensus {
	subjects: number
	noConcordance: number
	noCityTier: number
	nameDisagrees: number
	countrySplit: number
	tooFarApart: number
	coherent: number
}

/**
 * The coherent gold sets and the census of excluded subjects.
 */
export interface GoldSets {
	/**
	 * Maps each geonameid with a coherent set to its WOF IDs in ascending order.
	 */
	byGeonameID: Map<string, number[]>
	census: GoldCensus
}

/**
 * Reads the coherent gold set for each subject.
 *
 * The query joins the concordance to `spr` so the checks can read each WOF row's
 * placetype, name, country, and coordinate.
 * A subject yields a set only when all of its city-tier rows match the register's name,
 * sit in its country, and lie within {@link GOLD_COHERENCE_KM} of its coordinate.
 */
export async function readGoldSets(databasePath: PathBuilderLike, subjects: readonly GoldSubject[]): Promise<GoldSets> {
	using db = new DatabaseClient<WOFGazetteerDatabase>(databasePath, { readOnly: true })

	const identifiers = subjects.map((subject) => subject.geonameid)
	const rowsByGeonameID = new Map<string, ConcordanceRow[]>()

	for (let start = 0; start < identifiers.length; start += IDENTIFIERS_PER_QUERY) {
		const chunk = identifiers.slice(start, start + IDENTIFIERS_PER_QUERY)

		const result = await sql<ConcordanceRow>`
			select c.other_id as other_id, c.id as id, s.placetype as placetype, s.name as name,
			       s.country as country, s.latitude as latitude, s.longitude as longitude
			from concordances c join spr s on s.id = c.id
			where c.other_source = ${GEONAMES_SOURCE} and c.other_id in (${sql.join(chunk)})
		`.execute(db)

		for (const row of result.rows) {
			rowsByGeonameID.set(row.other_id, [...(rowsByGeonameID.get(row.other_id) ?? []), row])
		}
	}

	const byGeonameID = new Map<string, number[]>()

	const census: GoldCensus = {
		subjects: subjects.length,
		noConcordance: 0,
		noCityTier: 0,
		nameDisagrees: 0,
		countrySplit: 0,
		tooFarApart: 0,
		coherent: 0,
	}

	for (const subject of subjects) {
		const rows = rowsByGeonameID.get(subject.geonameid)

		if (!rows) {
			census.noConcordance++

			continue
		}

		const tier = rows.filter((row) => CITY_TIER.has(row.placetype))

		if (!tier.length) {
			census.noCityTier++

			continue
		}

		// The gazetteer may carry either the register's native name or its ASCII transliteration.
		const accepted = new Set([normalizeLocalityForKey(subject.name), normalizeLocalityForKey(subject.asciiname)])

		if (!tier.every((row) => accepted.has(normalizeLocalityForKey(row.name)))) {
			census.nameDisagrees++

			continue
		}

		if (tier.some((row) => row.country !== subject.country)) {
			census.countrySplit++

			continue
		}

		if (tier.some((row) => haversineKm(row.latitude, row.longitude, subject.lat, subject.lon) > GOLD_COHERENCE_KM)) {
			census.tooFarApart++

			continue
		}

		census.coherent++

		// The concordance table repeats some links, so the IDs need deduplicating.
		byGeonameID.set(
			subject.geonameid,
			[...new Set(tier.map((row) => row.id))].toSorted((left, right) => left - right)
		)
	}

	return { byGeonameID, census }
}
