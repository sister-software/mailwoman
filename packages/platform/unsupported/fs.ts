import type * as Native from "node:fs"

import { createNotImplementedFunction } from "../internal.ts"

export const Dirent = createNotImplementedFunction<typeof Native.Dirent>("node:fs")

export type Dirent = Native.Dirent

export type PathLike = Native.PathLike
export const Stats = createNotImplementedFunction<typeof Native.Stats>("node:fs")

export type Stats = Native.Stats
export const WriteStream = createNotImplementedFunction<typeof Native.WriteStream>("node:fs")

export type WriteStream = Native.WriteStream
export const constants = createNotImplementedFunction<typeof Native.constants>("node:fs")
export const createReadStream = createNotImplementedFunction<typeof Native.createReadStream>("node:fs")

export type ReadStream = Native.ReadStream
export const createWriteStream = createNotImplementedFunction<typeof Native.createWriteStream>("node:fs")
