import type * as Native from "node:stream"

import { createNotImplementedFunction } from "../internal.ts"

export const Readable = createNotImplementedFunction<typeof Native.Readable>("node:stream")

export type Readable = Native.Readable
