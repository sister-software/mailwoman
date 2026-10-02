/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import { tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { referentialFromPopulation } from "@mailwoman/core/resolver"
import type { CandidateTable } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import {
	rankByPrimaryPreference,
	type RankedRow,
	RERANK_FETCH,
} from "@mailwoman/resolver-wof-sqlite/primary-preference"
import { applyProximityRerank } from "@mailwoman/resolver-wof-sqlite/proximity-rerank"
import { normalizeLocalityForKey, stripLocalityQualifier } from "@mailwoman/resolver-wof-sqlite/street/normalize"

import type { MailwomanLookupLike } from "#browser-cascade"
import { memoizeResettable, type RangeDatabase, tableExists } from "#httpvfs/database"
import type { SQLValue } from "#httpvfs/worker-protocol"

type CandidateProbeRow = Pick<
	CandidateTable,
	| "spr_id"
	| "name"
	| "country_id"
	| "placetype_id"
	| "latitude"
	| "longitude"
	| "min_lat"
	| "min_lon"
	| "max_lat"
	| "max_lon"
	| "neg_rank"
> &
	Partial<Pick<CandidateTable, "population" | "is_primary" | "importance">>

const CANDIDATE_PROBE_COLUMNS =
	"spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank"

const OPTIONAL_CANDIDATE_COLUMNS = ["population", "is_primary", "importance"] as const

interface CandidateCodeMaps {
	countryToID: Map<string, number>
	idToCountry: Map<number, string>
	placetypeToID: Map<string, number>
	idToPlacetype: Map<number, string>
}

/**
 * A `WHERE` clause under construction: its conditions and their positional parameters, in order.
 */
interface Conditions {
	sql: string[]
	parameters: SQLValue[]
}

/**
 * Implements the browser place lookup over the byte-range candidate table,
 * resolving each query with one B-tree probe on `name_key` and no FTS or join.
 *
 * Keys must be normalized with {@link normalizeLocalityForKey}, the same function the build uses.
 * A parsed region's bbox filters the locality probe by candidate centroid.
 */
export class WOFCandidateTableLookup implements MailwomanLookupLike {
	readonly #database: RangeDatabase

	constructor(database: RangeDatabase) {
		this.#database = database
	}

	readonly #postalCityPresent = memoizeResettable(() => tableExists(this.#database, "postal_city_candidate"))

	readonly #optionalColumns = memoizeResettable(async (): Promise<string> => {
		const rows = await this.#database.query<{ name: string }>("SELECT name FROM pragma_table_info('candidate')")
		const present = new Set(rows.map((row) => row.name))

		return OPTIONAL_CANDIDATE_COLUMNS.filter((column) => present.has(column))
			.map((column) => `, ${column}`)
			.join("")
	})

	readonly #codeMaps = memoizeResettable(async (): Promise<CandidateCodeMaps> => {
		const [countries, placetypes] = await Promise.all([
			this.#database.query<{ id: number; code: string }>("SELECT id, code FROM country_codes"),
			this.#database.query<{ id: number; placetype: string }>("SELECT id, placetype FROM placetype_codes"),
		])

		const countryToID = new Map<string, number>()
		const idToCountry = new Map<number, string>()

		for (const row of countries) {
			const code = row.code.toUpperCase()

			countryToID.set(code, row.id)
			idToCountry.set(row.id, code)
		}

		const placetypeToID = new Map<string, number>()
		const idToPlacetype = new Map<number, string>()

		for (const row of placetypes) {
			placetypeToID.set(row.placetype, row.id)
			idToPlacetype.set(row.id, row.placetype)
		}

		return { countryToID, idToCountry, placetypeToID, idToPlacetype }
	})

	/**
	 * Fetches the code tables, the column list and a representative candidate probe
	 * during idle time, before the first real lookup.
	 */
	async warmUp(): Promise<void> {
		await Promise.all([this.#codeMaps(), this.#optionalColumns(), this.#postalCityPresent()])

		await this.#database.query("SELECT spr_id FROM candidate WHERE name_key = ? ORDER BY neg_rank ASC LIMIT 3", [
			"springfield",
		])
	}

	async findPlace(query: Parameters<MailwomanLookupLike["findPlace"]>[0]) {
		const text = (query.text ?? "").trim()

		if (!text) return []
		const nameKey = normalizeLocalityForKey(text)

		if (!nameKey) return []

		const requestedPlacetypes = query.placetype
			? (Array.isArray(query.placetype) ? query.placetype : [query.placetype]).filter(isPresent)
			: []

		const wantsLocality =
			requestedPlacetypes.length === 0 || expandPlacetypeFilter(requestedPlacetypes).includes("locality")

		if (query.postcode && wantsLocality && (await this.#postalCityPresent())) {
			const [hit] = await this.#database.query<{ spr_id: number; name: string; latitude: number; longitude: number }>(
				"SELECT spr_id, name, latitude, longitude FROM postal_city_candidate WHERE name_key = ? AND postcode = ? LIMIT 1",
				[nameKey, query.postcode.trim()]
			)

			if (hit) {
				return [
					{
						id: Number(hit.spr_id),
						name: String(hit.name ?? ""),
						placetype: "locality",
						country: query.country?.toUpperCase(),
						lat: Number(hit.latitude),
						lon: Number(hit.longitude),
						score: 1,
						exactMatch: true,
						bbox: undefined,
					},
				]
			}
		}

		const limit = Math.max(1, query.limit ?? 10)
		const { countryToID, idToCountry, placetypeToID, idToPlacetype } = await this.#codeMaps()

		const filters: Conditions = { sql: [], parameters: [] }

		if (query.country) {
			const countryID = countryToID.get(query.country.toUpperCase())

			if (countryID === undefined) return []
			filters.sql.push("country_id = ?")
			filters.parameters.push(countryID)
		}

		if (requestedPlacetypes.length) {
			const placetypeIDs = expandPlacetypeFilter(requestedPlacetypes)
				.map((placetype) => placetypeToID.get(placetype))
				.filter((id): id is number => id !== undefined)

			if (!placetypeIDs.length) return []
			filters.sql.push(`placetype_id IN (${placetypeIDs.map(() => "?").join(", ")})`)
			filters.parameters.push(...placetypeIDs)
		}

		if (query.bbox) {
			const { minLat, maxLat, minLon, maxLon } = query.bbox

			filters.sql.push("latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?")
			filters.parameters.push(Number(minLat), Number(maxLat), Number(minLon), Number(maxLon))
		}

		const sql =
			`SELECT ${CANDIDATE_PROBE_COLUMNS}${await this.#optionalColumns()} FROM candidate ` +
			`WHERE ${["name_key = ?", ...filters.sql].join(" AND ")} ORDER BY neg_rank ASC LIMIT ?`

		const probe = async (key: string): Promise<Array<RankedRow<CandidateProbeRow>>> => {
			const fetched = await this.#database.query<CandidateProbeRow>(sql, [
				key,
				...filters.parameters,
				Math.max(limit, RERANK_FETCH),
			])

			return rankByPrimaryPreference(fetched, limit, undefined, idToPlacetype)
		}

		let rows = await probe(nameKey)

		if (!rows.length) {
			const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))

			if (strippedKey && strippedKey !== nameKey) {
				rows = await probe(strippedKey)
			}
		}

		const candidates = rows.map((row) => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null

			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: idToPlacetype.get(Number(row.placetype_id)) ?? "",

				country: idToCountry.get(Number(row.country_id)),
				lat: Number(row.latitude),
				lon: Number(row.longitude),

				score: -(row.neg_rank as number),
				prominence: -Number(row.effectiveNegRank),

				exactMatch: !row.demoted,

				...(typeof row.population === "number" && row.population > 0
					? { population: row.population, referential: referentialFromPopulation(row.population) }
					: {}),
				...(typeof row.importance === "number" && Number.isFinite(row.importance)
					? { importance: row.importance }
					: {}),
				bbox: hasBbox
					? {
							minLat: Number(row.min_lat),
							maxLat: Number(row.max_lat),
							minLon: Number(row.min_lon),
							maxLon: Number(row.max_lon),
						}
					: undefined,
			}
		})

		if (query.bias && query.bias.length) {
			applyProximityRerank(candidates, query.bias)
		}

		return candidates
	}
}

/**
 * Looks up a place's GeoJSON geometry by id in a range-read polygon database.
 */
export function makeRangePolygonLookup(database: RangeDatabase) {
	return {
		async get(id: number): Promise<unknown | null> {
			const [row] = await database.query<{ geom: string }>("SELECT geom FROM polygons WHERE id = ?", [Number(id)])

			if (!row) return null

			return tryParsingJSON(String(row.geom))
		},
	}
}
