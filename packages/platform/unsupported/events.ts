import type * as Native from "node:events"

import { createNotImplementedFunction } from "../internal.ts"

export const EventEmitter = createNotImplementedFunction("node:events") as unknown as typeof Native.EventEmitter

export type EventEmitter = Native.EventEmitter
export const once = createNotImplementedFunction("node:events") as unknown as typeof Native.once
