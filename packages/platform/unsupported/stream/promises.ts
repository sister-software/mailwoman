import type * as Native from "node:stream/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export const pipeline = createNotImplementedFunction("node:stream/promises") as unknown as typeof Native.pipeline
