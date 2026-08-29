import type * as Native from "node:url"

import { createNotImplementedFunction } from "../internal.ts"

export const fileURLToPath = createNotImplementedFunction("node:url") as unknown as typeof Native.fileURLToPath
export const pathToFileURL = createNotImplementedFunction("node:url") as unknown as typeof Native.pathToFileURL
