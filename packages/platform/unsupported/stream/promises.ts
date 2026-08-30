import type * as Native from "node:stream/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export const finished = createNotImplementedFunction<typeof Native.finished>("node:stream/promises")
export const pipeline = createNotImplementedFunction<typeof Native.pipeline>("node:stream/promises")
