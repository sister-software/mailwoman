/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Matches a place another source folds into the admin gazetteer against the WOF records already ingested.
 *
 *   WOF is the gazetteer's record of every place it holds. A folded place that matches a WOF record adds its names to
 *   that record and no row of its own. A place that matches no WOF record is folded as its own row and listed as a gap.
 *   A gap's source decides whether it may enter the `mailwoman` WOF forks: a GeoNames place may, under CC BY with its
 *   `gn:id`, and an Overture division may not, because its data is ODbL and WOF takes OpenStreetMap data as
 *   concordance only.
 */

import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import type { DatabaseClient, StatementSync } from "@mailwoman/sqlite/client"

/**
 * The placetype groups a match may cross, each with the farthest a matching WOF record may sit.
 *
 * Each radius is the 90th percentile of the distance between a WOF record
 * and the Overture division that shares its Wikidata id, measured over every WOF
 * repository on 2026-11-09: 4.48 km for 65,853 localities, 2.82 km for 8,498 localadmins,
 * 18.97 km for 12,176 counties and 64.42 km for 1,506 regions.
 * A country matches the WOF country record with the same country code, whatever its name or point.
 *
 * The two sources place a country's point by different rules, and only 29 of the
 * 87 Wikidata-paired countries share a primary name.
 */
export const MATCH_TIERS = {
	country: { placetypes: ["country"], radiusKm: Infinity },
	region: { placetypes: ["region", "macroregion"], radiusKm: 65 },
	county: { placetypes: ["county", "macrocounty"], radiusKm: 20 },
	settlement: { placetypes: ["locality", "localadmin", "borough"], radiusKm: 5 },
} as const

/**
 * The name of a {@link MATCH_TIERS} group.
 */
export type MatchTier = keyof typeof MATCH_TIERS

const TIER_OF_PLACETYPE = new Map<string, MatchTier>(
	Object.entries(MATCH_TIERS).flatMap(([tier, { placetypes }]) =>
		placetypes.map((placetype) => [placetype, tier as MatchTier] as const)
	)
)

/**
 * The tier a placetype matches within, or null for a placetype no fold writes.
 */
export function matchTier(placetype: string): MatchTier | null {
	return TIER_OF_PLACETYPE.get(placetype) ?? null
}

/**
 * A place another source is about to fold.
 */
export interface FoldCandidate {
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	wikidata?: string | null
	geonamesID?: number | null
}

/**
 * The WOF record a folded place matched, and the evidence that matched it.
 */
export interface WOFMatch {
	id: number
	placetype: string
	by: "country" | "wikidata" | "geonames" | "name"
}

/**
 * A folded place that matched no WOF record, and so was folded as its own row.
 */
export interface FoldGap extends FoldCandidate {
	/**
	 * The source the place came from.
	 */
	source: "overture" | "geonames"
	/**
	 * The SPDX identifier of the license the source publishes its data under.
	 */
	license: string
	/**
	 * Whether the place may be added to the `mailwoman` WOF forks from this source's data.
	 */
	upstreamEligible: boolean
	/**
	 * The place's id in its source: an Overture GERS id or a GeoNames id.
	 */
	sourceID: string
	/**
	 * The id the fold gave the place's own row.
	 */
	id: number
}

/**
 * Each gap source's license, and whether its data may enter the WOF forks.
 *
 * Overture's Divisions theme is ODbL and derived largely from OpenStreetMap.
 * WOF lists OpenStreetMap as a concordance-only source.
 *
 * An Overture gap therefore shows a place WOF lacks, and its data stays out of the forks.
 */
export const GAP_SOURCE_TERMS = {
	overture: { license: "ODbL-1.0", upstreamEligible: false },
	geonames: { license: "CC-BY-4.0", upstreamEligible: true },
} as const satisfies Record<FoldGap["source"], { license: string; upstreamEligible: boolean }>

/**
 * The name-key table the matcher reads, built in the staging database
 * and dropped by {@link WOFPlaceIndex.dispose}.
 */
const NAME_KEY_TABLE = "fold_match_wof_name_key"

/**
 * WOF records ingested so far, indexed for matching folded places.
 */
export interface WOFPlaceIndex {
	/**
	 * The WOF record a candidate is, or null when no current WOF record of its tier matches it.
	 */
	match(candidate: FoldCandidate): WOFMatch | null
	/**
	 * Records a folded name on a matched WOF record, and answers whether the record lacked it.
	 *
	 * A name the record already has under the same key answers false, so the caller writes each new name once.
	 */
	claimName(match: Pick<WOFMatch, "id" | "placetype">, country: string, name: string): boolean
	/**
	 * Drops the name-key table from the staging database.
	 */
	dispose(): void
}

/**
 * Indexes the current WOF records in an open staging database.
 *
 * It reads every row below {@link OVERTURE_ID_BASE}, so it runs after the WOF ingest
 * and before any fold writes.
 * Names are keyed with {@link normalizeLocalityForKey}, the key the candidate table uses,
 * so a name the matcher treats as the same is one retrieval also treats as the same.
 */
export function buildWOFPlaceIndex(db: DatabaseClient<WOFDatabase>): WOFPlaceIndex {
	const placetypes = [...TIER_OF_PLACETYPE.keys()].map((placetype) => `'${placetype}'`).join(",")

	const concordance = (source: string) =>
		new Map(
			(
				db
					.prepare(
						`SELECT c.other_id AS other_id, s.id AS id, s.placetype AS placetype FROM concordances c
						 JOIN spr s ON s.id = c.id
						 WHERE c.other_source = ? AND s.is_current = 1 AND s.id < ${OVERTURE_ID_BASE} AND s.placetype IN (${placetypes})`
					)
					.all(source) as Array<{ other_id: string; id: number; placetype: string }>
			).map((row) => [String(row.other_id), { id: row.id, placetype: row.placetype }])
		)

	const byWikidata = concordance("wd:id")
	const byGeonames = concordance("gn:id")

	const countryRecords = new Map(
		(
			db
				.prepare(
					`SELECT country, min(id) AS id FROM spr
					 WHERE placetype = 'country' AND is_current = 1 AND id < ${OVERTURE_ID_BASE} GROUP BY country`
				)
				.all() as Array<{ country: string; id: number }>
		).map((row) => [row.country.toUpperCase(), row.id])
	)

	db.exec(`DROP TABLE IF EXISTS ${NAME_KEY_TABLE}`)

	db.exec(
		`CREATE TABLE ${NAME_KEY_TABLE} (country TEXT NOT NULL, name_key TEXT NOT NULL, id INTEGER NOT NULL, placetype TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, PRIMARY KEY (country, name_key, id)) WITHOUT ROWID`
	)

	// A place's name and its variants can fold to one key, and the key is stored once per place.
	const insert = db.prepare(`INSERT OR IGNORE INTO ${NAME_KEY_TABLE} VALUES (?, ?, ?, ?, ?, ?)`)

	const names = db
		.prepare(
			`SELECT s.id AS id, s.placetype AS placetype, s.country AS country, s.latitude AS latitude, s.longitude AS longitude, n.name AS name
			 FROM spr s JOIN names n ON n.id = s.id
			 WHERE s.is_current = 1 AND s.id < ${OVERTURE_ID_BASE} AND s.placetype IN (${placetypes})
			 UNION ALL
			 SELECT id, placetype, country, latitude, longitude, name FROM spr
			 WHERE is_current = 1 AND id < ${OVERTURE_ID_BASE} AND placetype IN (${placetypes})`
		)
		.iterate() as Iterable<{
		id: number
		placetype: string
		country: string
		latitude: number
		longitude: number
		name: string | null
	}>

	db.exec("BEGIN")

	for (const row of names) {
		const key = row.name ? normalizeLocalityForKey(row.name) : null

		if (key) {
			insert.run(row.country.toUpperCase(), key, row.id, row.placetype, row.latitude, row.longitude)
		}
	}

	db.exec("COMMIT")

	const byName: StatementSync = db.prepare(
		`SELECT id, placetype, latitude, longitude FROM ${NAME_KEY_TABLE} WHERE country = ? AND name_key = ?`
	)

	const hasName: StatementSync = db.prepare(
		`SELECT 1 FROM ${NAME_KEY_TABLE} WHERE country = ? AND name_key = ? AND id = ?`
	)

	/**
	 * The `<id>\0<key>` pairs claimed so far, so a name two folds share is written once.
	 */
	const claimed = new Set<string>()

	const sameTier = (placetype: string, tier: MatchTier) => matchTier(placetype) === tier

	return {
		match(candidate) {
			const tier = matchTier(candidate.placetype)

			if (!tier) return null

			if (tier === "country") {
				const id = countryRecords.get(candidate.country.toUpperCase())

				return id != null ? { id, placetype: "country", by: "country" } : null
			}

			const wikidata = candidate.wikidata ? byWikidata.get(candidate.wikidata) : null

			if (wikidata && sameTier(wikidata.placetype, tier)) return { ...wikidata, by: "wikidata" }

			const geonames = candidate.geonamesID != null ? byGeonames.get(String(candidate.geonamesID)) : null

			if (geonames && sameTier(geonames.placetype, tier)) return { ...geonames, by: "geonames" }

			const key = normalizeLocalityForKey(candidate.name)

			if (!key) return null

			const rows = byName.all(candidate.country.toUpperCase(), key) as Array<{
				id: number
				placetype: string
				latitude: number
				longitude: number
			}>

			const nearest = (within: MatchTier) => {
				const { radiusKm } = MATCH_TIERS[within]
				let best: { id: number; placetype: string; km: number } | null = null

				for (const row of rows) {
					if (!sameTier(row.placetype, within)) continue

					const km = haversine(candidate.latitude, candidate.longitude, row.latitude, row.longitude)

					if (km <= radiusKm && (!best || km < best.km)) {
						best = { id: row.id, placetype: row.placetype, km }
					}
				}

				return best ? { id: best.id, placetype: best.placetype, by: "name" as const } : null
			}

			// Some sources give a localadmin a county's extent: Overture's Belgian localadmins
			// are arrondissements, and WOF files an arrondissement as a county.
			// A localadmin with no settlement match therefore tries the county group
			// before it is written as a place of its own.
			return nearest(tier) ?? (candidate.placetype === "localadmin" ? nearest("county") : null)
		},
		claimName(match, country, name) {
			const key = normalizeLocalityForKey(name)

			if (!key) return false

			const claim = `${match.id}\u0000${key}`

			if (claimed.has(claim) || hasName.get(country.toUpperCase(), key, match.id)) return false

			claimed.add(claim)

			return true
		},
		dispose() {
			db.exec(`DROP TABLE IF EXISTS ${NAME_KEY_TABLE}`)
		},
	}
}
