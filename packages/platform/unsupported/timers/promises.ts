import type * as Native from "node:timers/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export const setTimeout = createNotImplementedFunction("node:timers/promises") as unknown as typeof Native.setTimeout
