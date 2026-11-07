/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The street table's schema and reads: merged streets and their crossings, with each row tied to the places that hold
 *   it by Who's On First id. The builder, a native reader and a Worker's range reader share these statements. The file
 *   holds no database client, so a Worker bundle can import it.
 *
 *   A read clusters on the written name, so a range reader fetches one run of pages for each lookup.
 */

import { normalizeStreetForKey } from "#street/normalize"

/**
 * One merged street: road links with one name, joined through a shared node.
 */
export interface StreetTable {
	id: number
	name: string
	latitude: number
	longitude: number
	/**
	 * The merged street's length in meters.
	 */
	meters: number
	/**
	 * A flat JSON array, `[lat0, lon0, lat1, lon1, …]`, with the midpoint of each road link.
	 */
	points: string
}

/**
 * One name a street is read under, with the street's extent so a search near
 * a point skips distant namesakes.
 */
export interface StreetNameTable {
	name_key: string
	street_id: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
}

/**
 * One place that holds part of a street, with the street's point inside that place.
 */
export interface StreetPlaceTable {
	name_key: string
	place_id: number
	street_id: number
	latitude: number
	longitude: number
}

/**
 * One location where two streets with different names meet.
 */
export interface StreetCrossingTable {
	/**
	 * The lower of the two name keys, in code-unit order.
	 */
	a_key: string
	b_key: string
	id: number
	latitude: number
	longitude: number
	/**
	 * The shared nodes merged into this location.
	 */
	nodes: number
}

/**
 * One place that holds a crossing.
 */
export interface StreetCrossingPlaceTable {
	crossing_id: number
	place_id: number
}

export interface StreetTableDatabase {
	street: StreetTable
	street_name: StreetNameTable
	street_place: StreetPlaceTable
	street_crossing: StreetCrossingTable
	street_crossing_place: StreetCrossingPlaceTable
}

/**
 * Creates the tables, clustered on the keys the reads below seek.
 */
export const STREET_TABLE_DDL = `
	CREATE TABLE street (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		meters REAL NOT NULL,
		points TEXT NOT NULL
	);
	CREATE TABLE street_name (
		name_key TEXT NOT NULL,
		street_id INTEGER NOT NULL,
		min_lat REAL NOT NULL,
		max_lat REAL NOT NULL,
		min_lon REAL NOT NULL,
		max_lon REAL NOT NULL,
		PRIMARY KEY (name_key, street_id)
	) WITHOUT ROWID;
	CREATE TABLE street_place (
		name_key TEXT NOT NULL,
		place_id INTEGER NOT NULL,
		street_id INTEGER NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		PRIMARY KEY (name_key, place_id, street_id)
	) WITHOUT ROWID;
	CREATE TABLE street_crossing (
		a_key TEXT NOT NULL,
		b_key TEXT NOT NULL,
		id INTEGER NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		nodes INTEGER NOT NULL,
		PRIMARY KEY (a_key, b_key, id)
	) WITHOUT ROWID;
	CREATE TABLE street_crossing_place (
		crossing_id INTEGER NOT NULL,
		place_id INTEGER NOT NULL,
		PRIMARY KEY (crossing_id, place_id)
	) WITHOUT ROWID;
`

/**
 * One way of reading a street.
 */
export interface StreetTableHit {
	streetID: number
	name: string
	lat: number
	lon: number
	meters: number
	/**
	 * Meters from the point the query searched near, or `null` for a query by place.
	 */
	distanceM: number | null
}

/**
 * One location where two streets meet.
 */
export interface CrossingHit {
	lat: number
	lon: number
	nodes: number
}

/**
 * A point to search around, with its radius in meters.
 */
export interface StreetTableArea {
	lat: number
	lon: number
	radiusM: number
}

export interface StreetTableQuery {
	street: string
	/**
	 * The Who's On First ids of the places that may hold the street.
	 */
	places?: readonly number[]
	/**
	 * The area a street must pass through.
	 * A query holds this or `places`.
	 */
	near?: StreetTableArea
}

export interface CrossingTableQuery {
	first: string
	second: string
	/**
	 * The places that may hold the crossing, or every place when absent.
	 */
	places?: readonly number[]
}

/**
 * Reads the street table.
 *
 * A failed read throws, because an empty answer claims the table holds no such street.
 */
export interface StreetTableLookup {
	findStreets(query: StreetTableQuery): Promise<StreetTableHit[]>
	findCrossings(query: CrossingTableQuery): Promise<CrossingHit[]>
}

/**
 * The most rows one lookup returns.
 */
export const STREET_TABLE_ROW_LIMIT = 50

/**
 * Returns the sorted pair of keys a crossing is stored under.
 */
export function crossingKeys(first: string, second: string): [string, string] {
	const a = String(normalizeStreetForKey(first))
	const b = String(normalizeStreetForKey(second))

	return a < b ? [a, b] : [b, a]
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ")

/**
 * The statement and parameters that read a street's rows inside the given places.
 */
export function streetsInPlacesStatement(street: string, places: readonly number[]): [string, Array<string | number>] {
	return [
		`SELECT DISTINCT s.id AS id, s.name AS name, p.latitude AS latitude, p.longitude AS longitude, s.meters AS meters
		 FROM street_place p JOIN street s ON s.id = p.street_id
		 WHERE p.name_key = ? AND p.place_id IN (${placeholders(places)})
		 LIMIT ${STREET_TABLE_ROW_LIMIT}`,
		[String(normalizeStreetForKey(street)), ...places],
	]
}

const METERS_PER_DEGREE_LATITUDE = 111_320

/**
 * The statement and parameters that read every street with this name whose extent reaches the area.
 */
export function streetsNearStatement(street: string, area: StreetTableArea): [string, Array<string | number>] {
	const latSpan = area.radiusM / METERS_PER_DEGREE_LATITUDE
	const lonSpan = latSpan / Math.max(Math.cos((area.lat * Math.PI) / 180), 0.01)

	return [
		`SELECT s.id AS id, s.name AS name, s.points AS points, s.meters AS meters
		 FROM street_name n JOIN street s ON s.id = n.street_id
		 WHERE n.name_key = ? AND n.max_lat >= ? AND n.min_lat <= ? AND n.max_lon >= ? AND n.min_lon <= ?
		 LIMIT ${STREET_TABLE_ROW_LIMIT}`,
		[
			String(normalizeStreetForKey(street)),
			area.lat - latSpan,
			area.lat + latSpan,
			area.lon - lonSpan,
			area.lon + lonSpan,
		],
	]
}

/**
 * The statement and parameters that read a crossing, inside the given places when there are any.
 */
export function crossingsStatement(query: CrossingTableQuery): [string, Array<string | number>] {
	const [a, b] = crossingKeys(query.first, query.second)

	if (!query.places?.length) {
		return [
			`SELECT latitude, longitude, nodes FROM street_crossing WHERE a_key = ? AND b_key = ? LIMIT ${STREET_TABLE_ROW_LIMIT}`,
			[a, b],
		]
	}

	return [
		`SELECT DISTINCT c.latitude AS latitude, c.longitude AS longitude, c.nodes AS nodes
		 FROM street_crossing c JOIN street_crossing_place p ON p.crossing_id = c.id
		 WHERE c.a_key = ? AND c.b_key = ? AND p.place_id IN (${placeholders(query.places)})
		 LIMIT ${STREET_TABLE_ROW_LIMIT}`,
		[a, b, ...query.places],
	]
}
