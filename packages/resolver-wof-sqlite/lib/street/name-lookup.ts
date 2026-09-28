/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The SQLite backend for {@link StreetLocalityEvidence}.
 *
 *   Reads a street-name index (the FR instance is BAN `street-centroids-fr.db`, a `street_centroid`
 *   table of `street_norm × locality_base × postcode` rows) and answers "does this street surface
 *   exist as a name" for the k-best rerank. It is sync-by-interface and read-only, uses prepared
 *   statements. It also degrades gracefully on a tableless extract, following the same reader discipline as
 *   `AddressPointSqliteLookup`.
 *
 *   The fold interface: the surface is folded with {@link foldStreetSurface} (the shared function),
 *   so the DB's `street_norm` column must have been built with that same fold or every hyphenated
 *   or apostrophe'd street silently misses. The column also needs a `street_norm` index before this
 *   backend is wired in production.
 */

import { foldStreetSurface, type StreetEvidenceScope, type StreetLocalityEvidence } from "@mailwoman/resolver"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup } from "@mailwoman/sqlite/lookup"
import type { PathBuilderLike } from "path-ts"

import type { WOFDatabase } from "#schema"
import { hasColumn, hasTable } from "#sqlite-utils"

export interface SQLiteStreetNameLookupOpts {
	/**
	 * ISO-2 (upper-case) countries this index answers for.
	 *
	 * Default `["FR"]` (the BAN street-centroids instance).
	 */
	countries?: Iterable<string>
	/**
	 * Table name.
	 *
	 * Default `street_centroid`.
	 */
	table?: string
}

/**
 * A {@link StreetLocalityEvidence} backed by a street-name SQLite index.
 *
 * Positive evidence only: any doubt (missing table, read miss) returns `false`,
 * so the rerank fails open to the model's ranking.
 */
export class SQLiteStreetNameLookup extends SQLiteLookup<WOFDatabase> implements StreetLocalityEvidence {
	readonly countries: ReadonlySet<string>
	readonly #byName: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #byNameLocality: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #byNamePostcode: ReturnType<DatabaseClient["prepare"]> | undefined

	constructor(dbPath: PathBuilderLike, opts: SQLiteStreetNameLookupOpts = {}) {
		super({ databasePath: dbPath })
		this.countries = new Set([...(opts.countries ?? ["FR"])].map((c) => c.toUpperCase()))
		const table = opts.table ?? "street_centroid"

		// Degrade gracefully on an empty or tableless extract.
		// A no-op miss, never a crash.
		if (hasTable(this.database, table)) {
			// Prefer the `name_key` column (built with `foldStreetSurface`
			// and indexed by `idx_sc_name` for a direct seek).
			// On a pre-rebuild extract, `street_norm` is a correct fallback.
			// It uses a skip-scan.
			// The fold that built `name_key` must match `foldStreetSurface` here.
			// This is the fold-parity interface.
			const keyCol = hasColumn(this.database, table, "name_key") ? "name_key" : "street_norm"
			this.#byName = this.database.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ? LIMIT 1`)

			this.#byNameLocality = this.database.prepare(
				`SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND locality_base = ? LIMIT 1`
			)

			this.#byNamePostcode = this.database.prepare(
				`SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND postcode = ? LIMIT 1`
			)
		}
	}

	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean {
		if (!this.#byName) return false
		const norm = foldStreetSurface(streetSurface)

		if (!norm) return false

		// Scoped lookups tighten precision when the hypothesis carries a locality/postcode.
		// A scoped miss falls back to the unscoped probe.
		// The scope column may be incomplete, so a miss there does not establish absence.
		if (
			scope?.locality &&
			this.#byNameLocality &&
			this.#byNameLocality.get(norm, foldStreetSurface(scope.locality)) !== undefined
		) {
			return true
		}

		if (scope?.postcode && this.#byNamePostcode && this.#byNamePostcode.get(norm, scope.postcode) !== undefined) {
			return true
		}

		return this.#byName.get(norm) !== undefined
	}
}
