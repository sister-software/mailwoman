/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nuts-lookup` — EU coordinate → NUTS statistical-region codes (levels 1–3). Point-in-
 *   polygon over the Eurostat GISCO NUTS boundaries in a `node:sqlite` table. NUTS ids nest by
 *   prefix (`DE` → `DE1` → `DE11` → `DE111`), so we find the deepest containing region and derive
 *   its parents. An `@mailwoman/annotations` `Annotator`.
 */

import { DatabaseSync } from "node:sqlite"

import type { AnnotationSet, Annotator, NUTS } from "@mailwoman/annotations"

/**
 * Normalized geometry: an array of polygons, each `[outerRing, ...holes]`, each ring `[[lon,lat],…]`.
 */
/**
 * NUTS code lengths by level. The code is hierarchical and fixed-width per level — a two-letter country prefix plus one
 * digit per level — so the length IS the level.
 */
const NUTS_1_LENGTH = 3

/**
 * See {@link NUTS_1_LENGTH}.
 */
const NUTS_2_LENGTH = 4

/**
 * See {@link NUTS_1_LENGTH}.
 */
const NUTS_3_LENGTH = 5

export type MultiPolygonCoords = number[][][][]

/**
 * Ray-cast point-in-ring (even-odd rule). `ring` is `[[lon, lat], …]`.
 *
 * DELIBERATE DUPLICATE of `@mailwoman/spatial`'s `pointInRing`, kept local on purpose. This package has exactly one
 * dependency — zero-dep `@mailwoman/annotations` — and importing spatial to reach a fifteen-line ray cast would pull
 * `@mailwoman/core` with it, whose published tarball carries ~11 MB of libpostal/WOF/chromium-i18n data. Eleven
 * megabytes for fifteen lines is the wrong trade for a leaf lookup package. Measured 2026-08-02; if this package ever
 * gains a real spatial dependency, delete these and import them.
 */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
	let inside = false

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i]![0]!
		const yi = ring[i]![1]!
		const xj = ring[j]![0]!
		const yj = ring[j]![1]!

		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}

	return inside
}

function pointInPolygon(lon: number, lat: number, polygon: number[][][]): boolean {
	if (!polygon[0] || !pointInRing(lon, lat, polygon[0])) return false

	for (let i = 1; i < polygon.length; i++) if (pointInRing(lon, lat, polygon[i]!)) return false

	return true
}

/**
 * Inside any polygon of a (multi)polygon feature.
 */
export function pointInMultiPolygon(lon: number, lat: number, polygons: MultiPolygonCoords): boolean {
	return polygons.some((polygon) => pointInPolygon(lon, lat, polygon))
}

/**
 * Derive the nested NUTS levels from a NUTS id (`"DE111"` → `{ level1:"DE1", level2:"DE11", level3:"DE111" }`).
 */
export function nutsFromID(id: string): NUTS {
	const nuts: NUTS = {}

	if (id.length >= NUTS_1_LENGTH) {
		nuts.level1 = id.slice(0, 3)
	}

	if (id.length >= NUTS_2_LENGTH) {
		nuts.level2 = id.slice(0, 4)
	}

	if (id.length >= NUTS_3_LENGTH) {
		nuts.level3 = id.slice(0, 5)
	}

	return nuts
}

/**
 * A NUTS lookup over a built `node:sqlite` polygon table.
 */
export class NUTSLookup {
	#db: DatabaseSync
	#byLevelBox: ReturnType<DatabaseSync["prepare"]>

	constructor(opts: { databasePath: string } | { database: DatabaseSync }) {
		this.#db = "database" in opts ? opts.database : new DatabaseSync(opts.databasePath, { readOnly: true })

		this.#byLevelBox = this.#db.prepare(
			// The explicit alias pins the JS key: for a bare column ref, sqlite3_column_name returns the
			// SCHEMA's declared casing (`nutsId` in every shipped nuts.db — plus `nutsID` from builds made
			// in the window the casing sweep had renamed the DDL), not the query's spelling.
			`SELECT nutsId AS nutsID, geom FROM nuts_regions
			 WHERE level = ? AND minLat <= ? AND maxLat >= ? AND minLon <= ? AND maxLon >= ?`
		)
	}

	/**
	 * The nested NUTS codes containing `(lat, lon)`, or null when the point is outside the EU NUTS area.
	 */
	find(lat: number, lon: number): NUTS | null {
		for (const level of [3, 2, 1]) {
			const rows = this.#byLevelBox.all(level, lat, lat, lon, lon) as Array<{ nutsID: string; geom: string }>

			for (const row of rows) {
				if (pointInMultiPolygon(lon, lat, JSON.parse(row.geom) as MultiPolygonCoords)) return nutsFromID(row.nutsID)
			}
		}

		return null
	}

	close(): void {
		this.#db.close()
	}
}

/**
 * Build an `Annotator` filling `AnnotationSet.nuts` for EU coordinates (abstains elsewhere).
 */
export function makeNUTSAnnotator(lookup: NUTSLookup): Annotator {
	return ({ lat, lon }): Partial<AnnotationSet> => {
		// oxlint-disable-next-line unicorn/no-array-method-this-argument -- `lookup.find(lat, lon)` is a two-argument gazetteer probe, not Array#find
		const nuts = lookup.find(lat, lon)

		return nuts ? { nuts } : {}
	}
}
