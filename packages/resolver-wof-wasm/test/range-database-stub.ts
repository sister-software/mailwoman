/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Test twin of the browser's range-read database handle.
 *
 *   Wraps a node:sqlite-backed {@link DatabaseClient} as the {@link RangeDatabase} the browser readers
 *   consume: an async `query` that binds positional parameters and returns row objects, plus a zero
 *   `bytesRead` counter. Shared by the street-tier, candidate and parity suites so the stub cannot drift
 *   between them, alongside the per-test DisposableStack fixture those suites open their synthetic
 *   databases into.
 */

import type { RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import type { SQLValue } from "@mailwoman/resolver-wof-wasm/httpvfs/worker-protocol"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { aroundEach } from "vitest"

/**
 * Wrap a node:sqlite DB as a {@link RangeDatabase}.
 */
export function stubRangeDatabase<Schema>(db: DatabaseClient<Schema>): RangeDatabase {
	return {
		async query<Row>(sql: string, parameters: readonly SQLValue[] = []) {
			return db.prepare(sql).all(...parameters) as Row[]
		},
		bytesRead: async () => 0,
	}
}

/**
 * Every connection the calling suite's fixtures open.
 *
 * A DisposableStack disposes once and stays disposed, so each test gets a fresh one
 * rather than reusing the emptied stack.
 */
let openDatabases: DisposableStack

/**
 * Register the per-test DisposableStack that {@link trackDatabase} disposes into.
 *
 * Call once at module top level.
 */
export function registerOpenDatabases(): void {
	aroundEach(async (runTest) => {
		using databases = new DisposableStack()

		openDatabases = databases
		await runTest()
	})
}

/**
 * Track a fixture connection for disposal at test end.
 *
 * Answers the same connection for inline use.
 */
export function trackDatabase<T extends Disposable>(db: T): T {
	openDatabases.use(db)

	return db
}
