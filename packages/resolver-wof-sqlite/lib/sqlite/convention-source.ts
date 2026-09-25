/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { ADDRESS_CONVENTION_TABLE, type Convention, type ConventionSource } from "#convention/index"

/**
 * Reads per-place address conventions from the convention table in an attached
 * SQLite schema, caching each lookup, including misses.
 *
 * A missing table or unparseable row reads as no convention rather than throwing.
 */
export class SqliteConventionSource<DB> implements ConventionSource {
	readonly #db: DatabaseClient<DB>
	readonly #schema: string

	readonly #cache = new Map<number, Convention | null>()

	/**
	 * Creates a source over an open database that is, or has attached, the convention asset.
	 *
	 * @param db The open database handle.
	 * @param schema The schema that holds the convention table, either `main` or an attached extract's name.
	 */
	constructor(db: DatabaseClient<DB>, schema: string) {
		this.#db = db
		this.#schema = schema
	}

	get(wofID: number): Convention | undefined {
		const cached = this.#cache.get(wofID)

		if (cached !== undefined) return cached ?? undefined
		let value: Convention | null = null

		try {
			const row = this.#db
				.prepare(`SELECT convention FROM ${this.#schema}.${ADDRESS_CONVENTION_TABLE} WHERE wof_id = ?`)
				.get(wofID) as { convention: string } | undefined

			if (row?.convention) {
				value = tryParsingJSON<Convention>(row.convention)
			}
		} catch {
			value = null
		}

		this.#cache.set(wofID, value)

		return value ?? undefined
	}
}
