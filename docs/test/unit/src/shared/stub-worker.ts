/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Test twin of the sql.js-httpvfs worker handle.
 *
 *   Wraps a node:sqlite-backed {@link DatabaseClient} as the minimal httpvfs worker the browser
 *   readers consume — async `exec` answering the sql.js result shape (`[]` on no rows, else
 *   `[{columns, values}]`) plus a zero `bytesRead` counter. Shared by the street-tier, candidate,
 *   and parity suites so the stub cannot drift between them, alongside the per-test
 *   DisposableStack fixture those suites open their synthetic databases into.
 */

import type { HTTPVFSWorker } from "@mailwoman/docs/shared/httpvfs-resolver"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { aroundEach } from "vitest"

/**
 * Wrap a node:sqlite DB as the minimal httpvfs worker handle (async exec, sql.js result shape).
 */
export function stubWorker<Schema>(db: DatabaseClient<Schema>): HTTPVFSWorker {
	return {
		db: {
			async exec(sql: string) {
				const rows = db.prepare(sql).all() as Record<string, unknown>[]

				if (!rows.length) return []
				const columns = Object.keys(rows[0]!)

				return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }]
			},
		},
		bytesRead: async () => 0,
	}
}

/**
 * Every connection the calling suite's fixtures open. A DisposableStack disposes once and stays disposed, so each test
 * gets a fresh one rather than reusing the emptied stack.
 */
let openDatabases: DisposableStack

/**
 * Register the per-test DisposableStack that {@link trackDatabase} disposes into. Call once at module top level.
 */
export function registerOpenDatabases(): void {
	aroundEach(async (runTest) => {
		using databases = new DisposableStack()

		openDatabases = databases
		await runTest()
	})
}

/**
 * Track a fixture connection for disposal at test end. Answers the same connection for inline use.
 */
export function trackDatabase<T extends Disposable>(db: T): T {
	openDatabases.use(db)

	return db
}
