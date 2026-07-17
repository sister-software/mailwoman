/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #727 stage-2 phase 4c — the SQLite backend for {@link StreetLocalityEvidence}.
 *
 *   Reads a street-name index (the FR instance = BAN `street-centroids-fr.db`, a `street_centroid`
 *   table of `street_norm × locality_base × postcode` rows) and answers "does this street surface
 *   exist as a name" for the k-best rerank. Sync-by-interface, `readOnly`, prepared statements,
 *   graceful-degrade on a tableless shard — the same reader discipline as `AddressPointSqliteLookup`.
 *
 *   THE FOLD CONTRACT: the surface is folded with {@link foldStreetSurface} (the shared function),
 *   and the DB's `street_norm` column MUST have been built with that SAME fold or every hyphenated /
 *   apostrophe'd street silently misses. The current `street-centroids-fr.db` predates the contract
 *   fold (it folded without hyphen/apostrophe normalization); it must be REBUILT with
 *   `foldStreetSurface` + a `street_norm` index before this backend is wired in production. Until
 *   then this class is correct-by-construction against a fixture built with the contract fold, and
 *   the production rebuild is a tracked BAN-sdk follow-up.
 */

import { DatabaseSync } from "node:sqlite"

import { foldStreetSurface, type StreetEvidenceScope, type StreetLocalityEvidence } from "@mailwoman/resolver"

function hasTable(db: DatabaseSync, table: string): boolean {
	const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table)

	return row !== undefined
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	// `table` is a caller-controlled identifier (default `street_centroid`), not user input — safe to interpolate.
	for (const row of db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>) {
		if (row.name === column) return true
	}

	return false
}

export interface SQLiteStreetNameLookupOpts {
	/** ISO-2 (upper-case) countries this index answers for. Default `["FR"]` (the BAN street-centroids instance). */
	countries?: Iterable<string>
	/** Table name. Default `street_centroid`. */
	table?: string
}

/**
 * A {@link StreetLocalityEvidence} backed by a street-name SQLite index. Positive evidence only: any doubt (missing
 * table, read miss) returns `false`, so the rerank fails open to the model's ranking.
 */
export class SQLiteStreetNameLookup implements StreetLocalityEvidence {
	readonly countries: ReadonlySet<string>
	readonly #db: DatabaseSync
	readonly #byName: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byNameLocality: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byNamePostcode: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(dbPath: string, opts: SQLiteStreetNameLookupOpts = {}) {
		this.countries = new Set([...(opts.countries ?? ["FR"])].map((c) => c.toUpperCase()))
		this.#db = new DatabaseSync(dbPath, { readOnly: true })
		const table = opts.table ?? "street_centroid"

		// Degrade gracefully on an empty/tableless shard — a no-op miss, never a crash (#568 discipline).
		if (hasTable(this.#db, table)) {
			// Prefer the #727 phase-4c `name_key` column (foldStreetSurface, indexed by `idx_sc_name` for a direct seek);
			// fall back to `street_norm` on a pre-rebuild shard (a skip-scan, but correct). The fold used to build
			// `name_key` MUST match `foldStreetSurface` here (the fold-parity contract).
			const keyCol = hasColumn(this.#db, table, "name_key") ? "name_key" : "street_norm"
			this.#byName = this.#db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ? LIMIT 1`)
			this.#byNameLocality = this.#db.prepare(
				`SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND locality_base = ? LIMIT 1`
			)
			this.#byNamePostcode = this.#db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND postcode = ? LIMIT 1`)
		}
	}

	hasStreetName(streetSurface: string, scope?: StreetEvidenceScope): boolean {
		if (!this.#byName) return false
		const norm = foldStreetSurface(streetSurface)

		if (!norm) return false

		// Scoped lookups tighten precision when the hypothesis carries a locality/postcode; a scoped MISS falls back to the
		// unscoped probe (index incompleteness in the scope column is not evidence of absence — positive-evidence rule).
		if (scope?.locality && this.#byNameLocality) {
			if (this.#byNameLocality.get(norm, foldStreetSurface(scope.locality)) !== undefined) return true
		}

		if (scope?.postcode && this.#byNamePostcode) {
			if (this.#byNamePostcode.get(norm, scope.postcode) !== undefined) return true
		}

		return this.#byName.get(norm) !== undefined
	}

	/** Close the underlying handle. */
	close(): void {
		this.#db.close()
	}
}
