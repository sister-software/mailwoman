/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { WOFDatabase } from "#schema"

/**
 * One postcode row from the WOF gazetteer, where a `lat`/`lon` of 0 means the
 * postcode is known but has no centroid.
 */
export interface PostcodePlace {
	country: string
	lat: number
	lon: number
}

const LOOKUP_SQL =
	"SELECT country, latitude AS lat, longitude AS lon FROM spr WHERE name = ? AND placetype = 'postalcode' AND is_current != 0"

/**
 * Looks up current WOF `postalcode` places by exact name across one or more read-only gazetteer databases.
 */
export class WOFPostcodeLookup {
	readonly #dbs: DatabaseClient<WOFDatabase>[]
	readonly #stmts: ReturnType<DatabaseClient["prepare"]>[]

	/**
	 * Opens each database read-only and prepares its exact-match statement.
	 */
	constructor(dbPaths: readonly PathBuilderLike[]) {
		this.#dbs = dbPaths.map((p) => new DatabaseClient<WOFDatabase>(p, { readOnly: true }))
		this.#stmts = this.#dbs.map((db) => db.prepare(LOOKUP_SQL))
	}

	/**
	 * Returns the union of exact-name matches for `postcode` across every database, without deduplication.
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
