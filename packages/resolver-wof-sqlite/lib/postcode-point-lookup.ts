/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite-backed postcode lookup for the postcode anchor (#240). A thin exact-match resolver over
 *   one or more `postalcode-*.db` extracts (the `spr` schema built by `build-unified-wof --placetypes
 *   postalcode`, then centroid-backfilled by `scripts/backfill-postcode-centroids.ts`).
 *
 *   This is the production implementation of the `PostcodeResolver` interface consumed by
 *   `@mailwoman/neural`'s `extractPostcodeAnchors`. It is deliberately dumb: an indexed exact-match
 *   on the postcode string across every extract, unioned. No FTS, no ranking, no proximity — the
 *   anchor only needs "does this string exist as a postcode, in which countries, near where". A
 *   future WASM build swaps this for an FST-backed resolver behind the same `lookup()` seam.
 *
 *   Why multiple extracts instead of the multi-extract `WOFSQLitePlaceLookup`: that resolver routes a
 *   query to ONE extract by placetype, but every postcode extract shares `placetype='postalcode'`, so a
 *   single query could only ever hit one country's extract. The anchor needs the union across
 *   countries to build its country posterior, so it queries each extract directly.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { WOFDatabase } from "#schema"

/**
 * A gazetteer hit. `lat`/`lon` of 0 means the postcode is known but has no centroid (no admin parent).
 */
export interface PostcodePlace {
	country: string
	lat: number
	lon: number
}

const LOOKUP_SQL =
	"SELECT country, latitude AS lat, longitude AS lon FROM spr WHERE name = ? AND placetype = 'postalcode' AND is_current != 0"

export class WOFPostcodeLookup {
	readonly #dbs: DatabaseClient<WOFDatabase>[]
	readonly #stmts: ReturnType<DatabaseClient["prepare"]>[]

	/**
	 * Open each extract read-only and prepare its exact-match statement.
	 */
	constructor(dbPaths: readonly string[]) {
		this.#dbs = dbPaths.map((p) => new DatabaseClient<WOFDatabase>(p, { readOnly: true }))
		this.#stmts = this.#dbs.map((db) => db.prepare(LOOKUP_SQL))
	}

	/**
	 * Exact-match the postcode across every extract and union the rows.
	 */
	lookup(postcode: string): PostcodePlace[] {
		const out: PostcodePlace[] = []

		for (const stmt of this.#stmts) {
			for (const row of stmt.all(postcode)) {
				out.push({ country: String(row.country), lat: Number(row.lat), lon: Number(row.lon) })
			}
		}

		return out
	}

	[Symbol.dispose](): void {
		for (const db of this.#dbs) {
			db.destroy()
		}
	}
}
