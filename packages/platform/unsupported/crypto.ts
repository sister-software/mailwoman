import type * as Native from "node:crypto"

import { createNotImplementedFunction } from "../internal.ts"

export const Hash = createNotImplementedFunction<typeof Native.Hash>("node:crypto")

export type Hash = Native.Hash
export const createHash = createNotImplementedFunction<typeof Native.createHash>("node:crypto")
export const randomBytes = createNotImplementedFunction<typeof Native.randomBytes>("node:crypto")
export const randomUUID = createNotImplementedFunction<typeof Native.randomUUID>("node:crypto")
