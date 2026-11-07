/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { AddressStatementRunner } from "#address/keys/lookup"

/**
 * An {@link AddressStatementRunner} over a local `lookup.db`, for the CLI and the Node API.
 *
 * It lives apart from the reader, so the browser loads the reader without `node:sqlite`.
 */
export function localAddressStatementRunner(db: DatabaseClient<unknown>): AddressStatementRunner {
	return {
		query: async <Row>(sql: string, parameters: readonly (string | number)[]) =>
			db.prepare(sql).all(...parameters) as Row[],
	}
}
