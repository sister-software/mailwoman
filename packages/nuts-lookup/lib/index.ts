/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nuts-lookup` — EU coordinate → nuts statistical-region codes (levels 1–3). Point-in-
 *   polygon over the Eurostat gisco nuts boundaries in a `node:sqlite` table. nuts ids nest by
 *   prefix (`DE` → `DE1` → `DE11` → `DE111`), so we find the deepest containing region and derive
 *   its parents. An `@mailwoman/annotations` `Annotator`.
 */

import type { AnnotationSet, Annotator, NUTS } from "@mailwoman/annotations"
import { parseJSONStrict } from "@mailwoman/core/json"
import { pointInMultiPolygon, type MultiPolygonRings } from "@mailwoman/spatial/geometries/polygon"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"

import type { NUTSDatabase } from "#schema"

/**
 * Nuts code lengths by level.
 *
 * The code is hierarchical and fixed-width per level — a two-letter country prefix
 * plus one digit per level — so the length is the level.
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

/**
 * Derive the nested nuts levels from a nuts id (`"DE111"` → `{ level1:"DE1", level2:"DE11", level3:"DE111" }`).
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
 * How many parsed regions {@link NUTSLookup} keeps. 256 covers every region a bounded-area
 * workload touches while holding a small fraction of the table.
 */
const GEOMETRY_CACHE_LIMIT = 256

/**
 * A nuts lookup over a built `node:sqlite` polygon table.
 */
export class NUTSLookup extends SQLiteLookup<NUTSDatabase> {
	#byLevelBox: ReturnType<DatabaseClient["prepare"]>
	/**
	 * Parsed geometry by nuts id, most recently used last.
	 *
	 * The table is read-only, so an entry never goes stale.
	 * The cache is bounded because the shipped `nuts.db` contains 14.3 MB of geometry JSON over 2,010 regions.
	 *
	 * A lookup service that answers points across the whole EU would otherwise hold every region parsed.
	 */
	readonly #geometryCache = new Map<string, MultiPolygonRings>()

	constructor(opts: SQLiteLookupOptions<NUTSDatabase>) {
		super(opts)

		this.#byLevelBox = this.database.prepare(
			// The explicit alias pins the JS key: for a bare column ref, sqlite3_column_name returns
			// the schema's declared casing (`nutsId` in every shipped nuts.db — plus `nutsID` from
			// builds made in the window the casing sweep had renamed the DDL), not the query's spelling.
			`SELECT nutsId AS nutsID, geom FROM nuts_regions
			 WHERE level = ? AND minLat <= ? AND maxLat >= ? AND minLon <= ? AND maxLon >= ?`
		)
	}

	/**
	 * The nested nuts codes containing `(lat, lon)`, or null when the point is outside the EU nuts area.
	 */
	explore(lat: number, lon: number): NUTS | null {
		for (const level of [3, 2, 1]) {
			const rows = this.#byLevelBox.all(level, lat, lat, lon, lon) as Array<{ nutsID: string; geom: string }>

			for (const row of rows) {
				if (pointInMultiPolygon(lon, lat, this.#geometry(row))) {
					return nutsFromID(row.nutsID)
				}
			}
		}

		return null
	}

	#geometry(row: { nutsID: string; geom: string }): MultiPolygonRings {
		const cached = this.#geometryCache.get(row.nutsID)

		if (cached) {
			this.#geometryCache.delete(row.nutsID)
			this.#geometryCache.set(row.nutsID, cached)

			return cached
		}

		const parsed = parseJSONStrict<MultiPolygonRings>(row.geom)

		this.#geometryCache.set(row.nutsID, parsed)

		if (this.#geometryCache.size > GEOMETRY_CACHE_LIMIT) {
			this.#geometryCache.delete(this.#geometryCache.keys().next().value!)
		}

		return parsed
	}
}

/**
 * Build an `Annotator` filling `AnnotationSet.nuts` for EU coordinates (abstains elsewhere).
 */
export function makeNUTSAnnotator(lookup: NUTSLookup): Annotator {
	return ({ lat, lon }): Partial<AnnotationSet> => {
		const nuts = lookup.explore(lat, lon)

		return nuts ? { nuts } : {}
	}
}
