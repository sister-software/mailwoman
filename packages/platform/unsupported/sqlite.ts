import type * as Native from "node:sqlite"

import { createNotImplementedFunction } from "../internal.ts"

/**
 * The unsupported-runtime twin of the Node handle. See `../node/sqlite.ts` for what `DB` does.
 */
export type DatabaseSync<DB = unknown> = Native.DatabaseSync & {
	readonly __mailwomanDatabaseSchema?: DB
}

interface DatabaseSyncConstructor {
	new <DB = unknown>(location: string | URL, options?: Native.DatabaseSyncOptions): DatabaseSync<DB>
}

export const DatabaseSync = createNotImplementedFunction<DatabaseSyncConstructor>("node:sqlite")

export type DatabaseSyncOptions = Native.DatabaseSyncOptions

export type SQLInputValue = Native.SQLInputValue
export const StatementSync = createNotImplementedFunction<typeof Native.StatementSync>("node:sqlite")

export type StatementSync = Native.StatementSync
