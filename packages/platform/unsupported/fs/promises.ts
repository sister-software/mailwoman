import type * as Native from "node:fs/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export type FileHandle = Native.FileHandle
export const access = createNotImplementedFunction<typeof Native.access>("node:fs/promises")
export const copyFile = createNotImplementedFunction<typeof Native.copyFile>("node:fs/promises")
export const cp = createNotImplementedFunction<typeof Native.cp>("node:fs/promises")
export const mkdir = createNotImplementedFunction<typeof Native.mkdir>("node:fs/promises")
export const mkdtemp = createNotImplementedFunction<typeof Native.mkdtemp>("node:fs/promises")
export const open = createNotImplementedFunction<typeof Native.open>("node:fs/promises")
export const readFile = createNotImplementedFunction<typeof Native.readFile>("node:fs/promises")
export const readdir = createNotImplementedFunction<typeof Native.readdir>("node:fs/promises")
export const rename = createNotImplementedFunction<typeof Native.rename>("node:fs/promises")
export const rm = createNotImplementedFunction<typeof Native.rm>("node:fs/promises")
export const stat = createNotImplementedFunction<typeof Native.stat>("node:fs/promises")
export const unlink = createNotImplementedFunction<typeof Native.unlink>("node:fs/promises")
export const writeFile = createNotImplementedFunction<typeof Native.writeFile>("node:fs/promises")
