import type * as Native from "node:util"

import { createNotImplementedFunction } from "../internal.ts"

export const parseArgs = createNotImplementedFunction<typeof Native.parseArgs>("node:util")
export const parseEnv = createNotImplementedFunction<typeof Native.parseEnv>("node:util")
export const promisify = createNotImplementedFunction<typeof Native.promisify>("node:util")
