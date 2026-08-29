import type * as Native from "node:stream/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export const pipeline = createNotImplementedFunction<typeof Native.pipeline>("node:stream/promises")
