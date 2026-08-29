import type * as Native from "node:path"

import { createNotImplementedFunction } from "../internal.ts"

export const basename = createNotImplementedFunction("node:path") as unknown as typeof Native.basename
export const dirname = createNotImplementedFunction("node:path") as unknown as typeof Native.dirname
export const extname = createNotImplementedFunction("node:path") as unknown as typeof Native.extname
export const isAbsolute = createNotImplementedFunction("node:path") as unknown as typeof Native.isAbsolute
export const join = createNotImplementedFunction("node:path") as unknown as typeof Native.join
export const normalize = createNotImplementedFunction("node:path") as unknown as typeof Native.normalize
export const posix = createNotImplementedFunction("node:path") as unknown as typeof Native.posix
export const relative = createNotImplementedFunction("node:path") as unknown as typeof Native.relative
export const resolve = createNotImplementedFunction("node:path") as unknown as typeof Native.resolve
export const sep = createNotImplementedFunction("node:path") as unknown as typeof Native.sep
