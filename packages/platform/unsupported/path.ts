import type * as Native from "node:path"

import { createNotImplementedFunction } from "../internal.ts"

export const basename = createNotImplementedFunction<typeof Native.basename>("node:path")
export const dirname = createNotImplementedFunction<typeof Native.dirname>("node:path")
export const extname = createNotImplementedFunction<typeof Native.extname>("node:path")
export const isAbsolute = createNotImplementedFunction<typeof Native.isAbsolute>("node:path")
export const join = createNotImplementedFunction<typeof Native.join>("node:path")
export const normalize = createNotImplementedFunction<typeof Native.normalize>("node:path")
export const posix = createNotImplementedFunction<typeof Native.posix>("node:path")
export const relative = createNotImplementedFunction<typeof Native.relative>("node:path")
export const resolve = createNotImplementedFunction<typeof Native.resolve>("node:path")
export const sep = createNotImplementedFunction<typeof Native.sep>("node:path")
