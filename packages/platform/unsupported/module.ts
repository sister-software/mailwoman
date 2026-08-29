import type * as Native from "node:module"

import { createNotImplementedFunction } from "../internal.ts"

export const createRequire = createNotImplementedFunction("node:module") as unknown as typeof Native.createRequire

export const enableCompileCache = createNotImplementedFunction(
	"node:module"
) as unknown as typeof Native.enableCompileCache

export const findPackageJSON = createNotImplementedFunction("node:module") as unknown as typeof Native.findPackageJSON
export const registerHooks = createNotImplementedFunction("node:module") as unknown as typeof Native.registerHooks
