/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `node:sqlite` → typed-row seam, in ONE place.
 *
 *   `node:sqlite` types every result as `Record<string, SQLOutputValue>` because it cannot infer a row shape from SQL
 *   text, so every raw read needs an assertion somewhere. That assertion belongs at this boundary rather than repeated
 *   at each query site: a cast written inline is invisible to review and indistinguishable from a cast that is
 *   defeating a real check, which is how a branded key column came to be written with an unfolded value (#1757).
 *
 *   It lives in `core` rather than beside the resolver's readers because `@mailwoman/resolver-wof-sqlite` is an
 *   OPTIONAL peer of `mailwoman` — a static import of it from there would break the contract that lets a consumer
 *   install the CLI without the gazetteer backend. `core` is the one package every reader already depends on, and
 *   `core/kysley/driver.ts` already makes the identical assertion for the Kysely path.
 *
 *   The type-only import keeps `node:sqlite` out of the emitted graph, so this module stays safe to reach from the
 *   browser tier and the docs bundler (see `sealed-db.ts` for the value-side counterpart).
 */

import type { SQLInputValue, StatementSync } from "node:sqlite"

/**
 * Execute a prepared statement whose selected columns are described by `Row`.
 *
 * Callers own the correspondence: `Row` must match the statement's PROJECTION, not the table. A column added to the
 * table without being selected does not belong in `Row`, and a `Row` field the `SELECT` omits reads back `undefined` at
 * runtime while the type promises otherwise.
 */
export function allRows<Row>(statement: StatementSync, ...parameters: SQLInputValue[]): Row[] {
	return statement.all(...parameters) as unknown as Row[]
}

/**
 * Single-row counterpart to {@link allRows}. `undefined` when the statement matched nothing.
 */
export function getRow<Row>(statement: StatementSync, ...parameters: SQLInputValue[]): Row | undefined {
	return statement.get(...parameters) as unknown as Row | undefined
}
