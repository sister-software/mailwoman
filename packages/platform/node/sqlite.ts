import { DatabaseSync as NativeDatabaseSync } from "node:sqlite"
import type { DatabaseSyncOptions as NativeDatabaseSyncOptions } from "node:sqlite"

/**
 * A `node:sqlite` handle tagged with the schema it opened.
 *
 * `DB` is a tag, not query typing. `prepare()` and `exec()` take raw SQL either way. The tag stops two handles over
 * different artifacts from being swapped, so passing the wrong database is a compile error instead of an empty result.
 * For typed queries, wrap the handle in `DatabaseClient<Schema>` (`@mailwoman/core/kysley/client`).
 */
export type DatabaseSync<DB = unknown> = NativeDatabaseSync & {
	readonly __mailwomanDatabaseSchema?: DB
}

interface DatabaseSyncConstructor {
	new <DB = unknown>(location: string | URL, options?: NativeDatabaseSyncOptions): DatabaseSync<DB>
}

export const DatabaseSync = NativeDatabaseSync as DatabaseSyncConstructor

export { StatementSync } from "node:sqlite"
export type { DatabaseSyncOptions, SQLInputValue } from "node:sqlite"
