import type * as Native from "node:fs/promises"

import { createNotImplementedFunction } from "../../internal.ts"

export type FileHandle = Native.FileHandle
export const access = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.access
export const copyFile = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.copyFile
export const cp = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.cp
export const mkdir = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.mkdir
export const mkdtemp = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.mkdtemp
export const open = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.open
export const readFile = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.readFile
export const readdir = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.readdir
export const rename = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.rename
export const rm = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.rm
export const stat = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.stat
export const unlink = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.unlink
export const writeFile = createNotImplementedFunction("node:fs/promises") as unknown as typeof Native.writeFile
