/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The GeoNames-to-WOF identity join the same-data benchmark grades through (#2261), and the guard that
 *   decides when the join may be trusted.
 *
 *   WHY A JOIN IS NEEDED AT ALL. The gold entity is a GeoNames row, chosen so the truth is open and
 *   independent of Mailwoman's own gazetteer. The candidates are WOF rows, because that is what the
 *   backend answers with. Without a published link between the two, "the selection is correct" would have
 *   to be decided by distance — and distance is not identity: two same-named places a kilometre apart are
 *   different entities, and a correct selection 30 km from a large city's centroid is still correct.
 *
 *   THE GOLD IS A SET, NOT AN ID, AND THAT IS A MEASURED NECESSITY. Of the 13,465 `cities15000.txt` rows
 *   the shipped `admin-global-priority.db` concords at all, 4,304 concord to MORE THAN ONE city-tier WOF
 *   row — the gazetteer carries the same place twice. Grading against one arbitrary member would measure
 *   which duplicate an arm happened to return. So the gold is every city-tier row the concordance reaches,
 *   and a selection is correct when it names any member.
 *
 *   A SET IS ADMITTED ONLY WHEN IT IS COHERENT. Every member's folded name must agree with the register's
 *   name, every member must sit in the register's country, and every member must lie within
 *   {@link GOLD_COHERENCE_KM} of the register's coordinate. Without the guard the set stops being one
 *   place: 1,152 geonameids reach only a neighbourhood or a region — grading a locality selection against
 *   a region's id marks a correct answer wrong — and 1,492 reach a differently-named row.
 *
 *   EVERY REJECTION IS COUNTED. A geonameid the join cannot resolve is UNGRADEABLE and never enters the
 *   panel, and {@link GoldCensus} carries why. The counts are properties of the gazetteer, not choices the
 *   panel made, and reporting them keeps a coverage hole from reading as a selection rule.
 */

import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

/**
 * The concordance source key WOF writes for a GeoNames identifier.
 */
const GEONAMES_SOURCE = "gn:id"

/**
 * WOF placetypes that carry the tier a `cities15000.txt` row denotes. `localadmin` is admitted beside `locality`
 * because WOF splits the city tier across both, the same equivalence the resolver's own placetype groups use.
 */
const CITY_TIER = new Set(["locality", "localadmin"])

/**
 * How far a concorded WOF row may sit from the register's coordinate and still be the same place. Set at the wrong-area
 * threshold the benchmark already registers, so one distance means one thing throughout.
 */
export const GOLD_COHERENCE_KM = 25

/**
 * Identifiers per `IN` clause. SQLite's default host-parameter ceiling is 999, and staying under it keeps the filter in
 * SQL — the alternative, scanning the table's 2,057,196 `gn:id` rows into JavaScript and filtering there, materializes
 * two million objects on a host that also runs this repository's CI runners.
 */
const IDENTIFIERS_PER_QUERY = 900

/**
 * The two tables this reader touches in the WOF admin gazetteer, as the READ contract only — the artifact is built
 * elsewhere (`@mailwoman/resolver-wof-sqlite`'s unified schema owns its DDL), and a second builder here would be a
 * second definition of a shipped table.
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
 * The register row a gold set is checked against — the fields the guard reads, so a caller need not pass a whole
 * `GeoNamesCity` and this module need not depend on the panel builder.
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
 * Why a geonameid produced no gold. Each count names a different hole, and they are never summed into one number.
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

export interface GoldSets {
	/**
	 * Geonameid → the WOF ids that denote it, ascending. Only coherent sets appear.
	 */
	byGeonameID: Map<string, number[]>
	census: GoldCensus
}

/**
 * Read the coherent gold set for each subject.
 *
 * The concordance is queried in chunks and joined to `spr` so the guard can read the other side's placetype, name,
 * country and coordinate — a join that returned ids alone could not tell a locality from the region above it.
 */
export async function readGoldSets(databasePath: string, subjects: readonly GoldSubject[]): Promise<GoldSets> {
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

		// The register writes two names for a place — its own and an ASCII transliteration — and either may be the one
		// the gazetteer carries.
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

		byGeonameID.set(
			subject.geonameid,
			tier.map((row) => row.id).toSorted((left, right) => left - right)
		)
	}

	return { byGeonameID, census }
}
