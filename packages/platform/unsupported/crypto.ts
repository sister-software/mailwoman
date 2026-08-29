import type * as Native from "node:crypto"

import { createNotImplementedFunction } from "../internal.ts"

export const Hash = createNotImplementedFunction("node:crypto") as unknown as typeof Native.Hash
export const createHash = createNotImplementedFunction("node:crypto") as unknown as typeof Native.createHash
export const randomUUID = createNotImplementedFunction("node:crypto") as unknown as typeof Native.randomUUID
