/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `SqliteConventionSource` — a `ConventionSource` backed by the build-from-source convention asset
 *   (#290, Direction E). Conventions live in a read-only, provenance-stamped `address_convention`
 *   table keyed by WOF polygon id; this source queries them ON DEMAND by id (one indexed lookup,
 *   memoized) rather than paging the whole table into memory as a code constant — the deliberate
 *   counter to the Pelias "giant dictionary in RAM, no provenance" pattern (see the operator design
 *   value in memory `feedback-no-irrelevant-trivia`).
 *
 *   The asset is the queryable, distributable artifact; the strategy IMPLEMENTATIONS stay in code. An
 *   unknown strategy NAME is surfaced loudly at dispatch (see `lookup.ts`), not silently
 *   swallowed.
 */

import { tryParsingJSON } from "@mailwoman/core/objects"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { ADDRESS_CONVENTION_TABLE, type Convention, type ConventionSource } from "#convention/index"

export class SqliteConventionSource<DB> implements ConventionSource {
	readonly #db: DatabaseClient<DB>
	readonly #schema: string
	/**
	 * Memoize per-id lookups (including misses, as `null`) so a hot ancestor chain is queried once.
	 */
	readonly #cache = new Map<number, Convention | null>()

	/**
	 * @param db An open handle to a DB that has the convention asset attached (or is it).
	 * @param schema The schema name the `address_convention` table lives under (`main` or an ATTACHed extract name —
	 *   `WOFSQLitePlaceLookup` auto-detects which extract carries the table).
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
			// A missing table → treat as no override (the chain falls back to WORLD_DEFAULT); malformed
			// JSON already nulls out above. The build script validates structure, so this is purely defensive.
			value = null
		}

		this.#cache.set(wofID, value)

		return value ?? undefined
	}
}
