import type * as Native from "node:fs"

import { createNotImplementedFunction } from "../internal.ts"

export const Dirent = createNotImplementedFunction("node:fs") as unknown as typeof Native.Dirent

export type PathLike = Native.PathLike
export const Stats = createNotImplementedFunction("node:fs") as unknown as typeof Native.Stats
export const WriteStream = createNotImplementedFunction("node:fs") as unknown as typeof Native.WriteStream
export const accessSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.accessSync
export const appendFileSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.appendFileSync
export const chmodSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.chmodSync
export const closeSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.closeSync
export const constants = createNotImplementedFunction("node:fs") as unknown as typeof Native.constants
export const copyFileSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.copyFileSync
export const cpSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.cpSync
export const createReadStream = createNotImplementedFunction("node:fs") as unknown as typeof Native.createReadStream
export const createWriteStream = createNotImplementedFunction("node:fs") as unknown as typeof Native.createWriteStream
export const existsSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.existsSync
export const globSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.globSync
export const lstatSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.lstatSync
export const mkdirSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.mkdirSync
export const mkdtempSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.mkdtempSync
export const openSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.openSync
export const promises = createNotImplementedFunction("node:fs") as unknown as typeof Native.promises
export const readFileSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.readFileSync
export const readSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.readSync
export const readdirSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.readdirSync
export const readlinkSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.readlinkSync
export const realpathSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.realpathSync
export const renameSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.renameSync
export const rmSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.rmSync
export const rmdirSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.rmdirSync
export const statSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.statSync
export const symlinkSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.symlinkSync
export const unlinkSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.unlinkSync
export const utimesSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.utimesSync
export const writeFileSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.writeFileSync
export const writeSync = createNotImplementedFunction("node:fs") as unknown as typeof Native.writeSync

const unsupportedDefault = createNotImplementedFunction("node:fs") as unknown as typeof Native
export default unsupportedDefault
