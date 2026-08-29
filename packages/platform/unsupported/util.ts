import type * as Native from "node:util"

import { createNotImplementedFunction } from "../internal.ts"

export const parseArgs = createNotImplementedFunction("node:util") as unknown as typeof Native.parseArgs
export const parseEnv = createNotImplementedFunction("node:util") as unknown as typeof Native.parseEnv
export const promisify = createNotImplementedFunction("node:util") as unknown as typeof Native.promisify
