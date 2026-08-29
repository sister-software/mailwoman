import type * as Native from "node:readline"

import { createNotImplementedFunction } from "../internal.ts"

export const createInterface = createNotImplementedFunction<typeof Native.createInterface>("node:readline")
