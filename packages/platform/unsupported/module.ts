import type * as Native from "node:module"

import { createNotImplementedFunction } from "../internal.ts"

export const createRequire = createNotImplementedFunction<typeof Native.createRequire>("node:module")

export const enableCompileCache = createNotImplementedFunction<typeof Native.enableCompileCache>("node:module")

export const findPackageJSON = createNotImplementedFunction<typeof Native.findPackageJSON>("node:module")
export const registerHooks = createNotImplementedFunction<typeof Native.registerHooks>("node:module")
