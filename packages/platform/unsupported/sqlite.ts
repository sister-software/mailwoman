import type * as Native from "node:sqlite"

import { createNotImplementedFunction } from "../internal.ts"

export const DatabaseSync = createNotImplementedFunction("node:sqlite") as unknown as typeof Native.DatabaseSync

export type DatabaseSyncOptions = Native.DatabaseSyncOptions

export type SQLInputValue = Native.SQLInputValue
export const StatementSync = createNotImplementedFunction("node:sqlite") as unknown as typeof Native.StatementSync
