import type * as Native from "node:timers/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export const setTimeout = createNotImplementedFunction<typeof Native.setTimeout>("node:timers/promises")
