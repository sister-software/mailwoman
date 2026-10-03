/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one interface the query code needs. The browser passes the sqlite-wasm worker's `RangeDatabase`;
 *   the tests pass a `node:sqlite` adapter from `database.node.ts`.
 */

export type SQLValue = string | number | bigint | Uint8Array | null

export interface SearchDatabase {
	query<Row>(sql: string, parameters?: readonly SQLValue[]): Promise<Row[]>
}
