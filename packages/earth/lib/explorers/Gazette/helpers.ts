/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure helpers for the gazette explorer: the shape of a candidate row as the page reads it, the grouping
 *   of a prefix search's rows by name key, and the reading of a row the way the resolver reads it. Kept free
 *   of the range database so they unit-test without a worker.
 */

import { DEFAULT_PLACETYPE_MAP, expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import { referentialFromPopulation } from "@mailwoman/core/resolver"
import type { SQLValue } from "@mailwoman/resolver-wof-wasm/httpvfs/worker-protocol"

/**
 * One row of the browser candidate table, with its code columns resolved to their names.
 */
export interface PlaceRow {
	nameKey: string
	country: string
	regionID: number
	placetype: string
	/**
	 * The rank the resolver orders candidates by, ascending, so a lower value is a stronger candidate.
	 */
	negRank: number
	sprID: number
	name: string
	latitude: number | null
	longitude: number | null
	bbox: [minLon: number, minLat: number, maxLon: number, maxLat: number] | null
	population: number | null
	isPrimary: boolean
	importance: number | null
	nameRole: string | null
}

/**
 * The id-to-name maps the two code tables hold.
 */
export interface GazetteerCodes {
	countries: ReadonlyMap<number, string>
	placetypes: ReadonlyMap<number, string>
}

/**
 * The columns the page selects from the candidate table, in the order {@link rowFromRecord} reads them.
 */
export const PLACE_COLUMNS =
	"name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, longitude, min_lat, min_lon, max_lat, max_lon, population, is_primary, importance, name_role"

function numberOrNull(value: SQLValue | undefined): number | null {
	if (typeof value === "number") return value

	return typeof value === "bigint" ? Number(value) : null
}

/**
 * A candidate record as the range database returns it, resolved to a {@link PlaceRow}.
 *
 * A code the maps lack is shown as its number, so a stale code table is visible rather than blank.
 */
export function rowFromRecord(record: Record<string, SQLValue>, codes: GazetteerCodes): PlaceRow {
	const countryID = Number(record["country_id"])
	const placetypeID = Number(record["placetype_id"])
	const minLat = numberOrNull(record["min_lat"])
	const minLon = numberOrNull(record["min_lon"])
	const maxLat = numberOrNull(record["max_lat"])
	const maxLon = numberOrNull(record["max_lon"])

	return {
		nameKey: String(record["name_key"] ?? ""),
		country: codes.countries.get(countryID) ?? `#${countryID}`,
		regionID: Number(record["region_id"]),
		placetype: codes.placetypes.get(placetypeID) ?? `#${placetypeID}`,
		negRank: Number(record["neg_rank"]),
		sprID: Number(record["spr_id"]),
		name: String(record["name"] ?? ""),
		latitude: numberOrNull(record["latitude"]),
		longitude: numberOrNull(record["longitude"]),
		bbox:
			minLat !== null && minLon !== null && maxLat !== null && maxLon !== null
				? [minLon, minLat, maxLon, maxLat]
				: null,
		population: numberOrNull(record["population"]),
		isPrimary: record["is_primary"] === 1,
		importance: numberOrNull(record["importance"]),
		nameRole: typeof record["name_role"] === "string" ? record["name_role"] : null,
	}
}

/**
 * One name key of a search result: the strongest place under it and the count of places that share it.
 */
export interface NameGroup {
	nameKey: string
	top: PlaceRow
	count: number
}

/**
 * Groups search rows by name key, keeping the lowest-ranked row of each key as its face.
 *
 * Groups keep the order their keys first appear in.
 * For a prefix scan that is key order.
 */
export function groupByNameKey(rows: readonly PlaceRow[]): NameGroup[] {
	const groups = new Map<string, NameGroup>()

	for (const row of rows) {
		const group = groups.get(row.nameKey)

		if (!group) {
			groups.set(row.nameKey, { nameKey: row.nameKey, top: row, count: 1 })

			continue
		}

		group.count += 1

		if (row.negRank < group.top.negRank) {
			group.top = row
		}
	}

	return [...groups.values()]
}

/**
 * The parse tags whose placetype filter admits `placetype`, through the resolver's own tag map and groups.
 *
 * A row of placetype `borough` is admitted by `locality` and `dependent_locality`,
 * because both map to `locality` and the locality group expands to `borough`.
 */
export function tagsSelecting(placetype: string): string[] {
	const out: string[] = []

	for (const [tag, mapped] of Object.entries(DEFAULT_PLACETYPE_MAP)) {
		if (typeof mapped !== "string") continue

		if (expandPlacetypeFilter([mapped]).includes(placetype)) {
			out.push(tag)
		}
	}

	return out
}

/**
 * A row read the way the browser resolver reads it when a parse names this key.
 */
export interface ResolverReading {
	/**
	 * The key the lookup probes, the fold of the typed name.
	 */
	nameKey: string
	/**
	 * The parse tags whose filter admits the row's placetype.
	 */
	selectedByTags: string[]
	/**
	 * The population-anchored likelihood the ranking adds, in [0, 1].
	 */
	referential: number
	/**
	 * Whether the resolver reports the hit as an exact match: a primary name rather than a demoted alternate.
	 */
	exactMatch: boolean
}

export function resolverReading(row: PlaceRow): ResolverReading {
	return {
		nameKey: row.nameKey,
		selectedByTags: tagsSelecting(row.placetype),
		referential: referentialFromPopulation(row.population),
		exactMatch: row.isPrimary,
	}
}

/**
 * The upper bound of a prefix range over text keys: the prefix followed by the highest code unit.
 */
export function prefixUpperBound(prefix: string): string {
	return `${prefix}￿`
}

/**
 * The Spelunker page for a Who's On First id.
 */
export function spelunkerURL(sprID: number): string {
	return `https://spelunker.whosonfirst.org/id/${sprID}/`
}
