/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `node:sqlite` → typed-row boundary, in one place: `node:sqlite` types every result as
 *   `Record<string, SQLOutputValue>`, so every raw read needs an assertion, and it belongs here rather than at each
 *   query site because an inline cast is invisible to review and indistinguishable from one defeating a real check.
 *
 *   It lives in `core` because `@mailwoman/resolver-wof-sqlite` is an optional peer of `mailwoman`, and a static
 *   import from there would break installing the CLI without the gazetteer backend; the type-only import keeps
 *   `node:sqlite` out of the emitted graph, so the module stays safe to reach from the browser tier.
 */

import type { SQLInputValue, StatementSync } from "@mailwoman/sqlite/client"

/**
 * Execute a prepared statement whose selected columns are described by `Row`,
 * with the caller owning the correspondence: `Row` must match the statement's projection
 * rather than the table, because a column the `select` omits reads back `undefined`
 * at runtime while the type promises otherwise.
 */
export function allRows<Row>(statement: StatementSync, ...parameters: SQLInputValue[]): Row[] {
	return statement.all(...parameters) as Row[]
}

/**
 * Single-row counterpart to {@link allRows}, answering `undefined` when the statement matched no row.
 */
export function getRow<Row>(statement: StatementSync, ...parameters: SQLInputValue[]): Row | undefined {
	return statement.get(...parameters) as Row | undefined
}
