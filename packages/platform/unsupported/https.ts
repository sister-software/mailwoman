import type * as Native from "node:https"

import { createNotImplementedFunction } from "../internal.ts"

export const get = createNotImplementedFunction<typeof Native.get>("node:https")
