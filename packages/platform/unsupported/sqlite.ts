import type * as Native from "node:sqlite"

import { createNotImplementedFunction } from "../internal.ts"

export const DatabaseSync = createNotImplementedFunction<typeof Native.DatabaseSync>("node:sqlite")

export type DatabaseSync = Native.DatabaseSync

export type DatabaseSyncOptions = Native.DatabaseSyncOptions

export type FunctionOptions = Native.FunctionOptions

export type SQLInputValue = Native.SQLInputValue

export type SQLOutputValue = Native.SQLOutputValue
export const StatementSync = createNotImplementedFunction<typeof Native.StatementSync>("node:sqlite")

export type StatementSync = Native.StatementSync
