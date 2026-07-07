/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite-backed postcode lookup for the postcode anchor (#240). A thin exact-match resolver over
 *   one or more `postalcode-*.db` shards (the `spr` schema built by `build-unified-wof --placetypes
 *   postalcode`, then centroid-backfilled by `scripts/backfill-postcode-centroids.ts`).
 *
 *   This is the production implementation of the `PostcodeResolver` interface consumed by
 *   `@mailwoman/neural`'s `extractPostcodeAnchors`. It is deliberately dumb: an indexed exact-match
 *   on the postcode string across every shard, unioned. No FTS, no ranking, no proximity — the
 *   anchor only needs "does this string exist as a postcode, in which countries, near where". A
 *   future WASM build swaps this for an FST-backed resolver behind the same `lookup()` seam.
 *
 *   Why multiple shards instead of the multi-shard `WOFSqlitePlaceLookup`: that resolver routes a
 *   query to ONE shard by placetype, but every postcode shard shares `placetype='postalcode'`, so a
 *   single query could only ever hit one country's shard. The anchor needs the union across
 *   countries to build its country posterior, so it queries each shard directly.
 */

import { DatabaseSync } from "node:sqlite"

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
	readonly #dbs: DatabaseSync[]
	readonly #stmts: ReturnType<DatabaseSync["prepare"]>[]

	/** Open each shard read-only and prepare its exact-match statement. */
	constructor(dbPaths: readonly string[]) {
		this.#dbs = dbPaths.map((p) => new DatabaseSync(p, { readOnly: true }))
		this.#stmts = this.#dbs.map((db) => db.prepare(LOOKUP_SQL))
	}

	/** Exact-match the postcode across every shard and union the rows. */
	lookup(postcode: string): PostcodePlace[] {
		const out: PostcodePlace[] = []

		for (const stmt of this.#stmts) {
			for (const row of stmt.all(postcode)) {
				out.push({ country: String(row.country), lat: Number(row.lat), lon: Number(row.lon) })
			}
		}

		return out
	}

	close(): void {
		for (const db of this.#dbs) {
			db.close()
		}
	}
}
