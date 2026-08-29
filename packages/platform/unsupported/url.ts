import type * as Native from "node:url"

import { createNotImplementedFunction } from "../internal.ts"

export const fileURLToPath = createNotImplementedFunction<typeof Native.fileURLToPath>("node:url")
export const pathToFileURL = createNotImplementedFunction<typeof Native.pathToFileURL>("node:url")
