import type * as Native from "node:stream"

import { createNotImplementedFunction } from "../internal.ts"

export const Readable = createNotImplementedFunction<typeof Native.Readable>("node:stream")

export type Readable = Native.Readable

export const Writable = createNotImplementedFunction<typeof Native.Writable>("node:stream")

export type Writable = Native.Writable

export const Duplex = createNotImplementedFunction<typeof Native.Duplex>("node:stream")

export type Duplex = Native.Duplex
