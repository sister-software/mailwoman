import type * as Native from "node:events"

import { createNotImplementedFunction } from "../internal.ts"

export const EventEmitter = createNotImplementedFunction<typeof Native.EventEmitter>("node:events")

export type EventEmitter = Native.EventEmitter
export const once = createNotImplementedFunction<typeof Native.once>("node:events")
