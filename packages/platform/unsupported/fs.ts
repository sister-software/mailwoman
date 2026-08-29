import type * as Native from "node:fs"

import { createNotImplementedFunction } from "../internal.ts"

export const Dirent = createNotImplementedFunction<typeof Native.Dirent>("node:fs")

export type Dirent = Native.Dirent

export type PathLike = Native.PathLike
export const Stats = createNotImplementedFunction<typeof Native.Stats>("node:fs")

export type Stats = Native.Stats
export const WriteStream = createNotImplementedFunction<typeof Native.WriteStream>("node:fs")

export type WriteStream = Native.WriteStream
export const accessSync = createNotImplementedFunction<typeof Native.accessSync>("node:fs")
export const appendFileSync = createNotImplementedFunction<typeof Native.appendFileSync>("node:fs")
export const chmodSync = createNotImplementedFunction<typeof Native.chmodSync>("node:fs")
export const closeSync = createNotImplementedFunction<typeof Native.closeSync>("node:fs")
export const constants = createNotImplementedFunction<typeof Native.constants>("node:fs")
export const copyFileSync = createNotImplementedFunction<typeof Native.copyFileSync>("node:fs")
export const cpSync = createNotImplementedFunction<typeof Native.cpSync>("node:fs")
export const createReadStream = createNotImplementedFunction<typeof Native.createReadStream>("node:fs")
export const createWriteStream = createNotImplementedFunction<typeof Native.createWriteStream>("node:fs")
export const existsSync = createNotImplementedFunction<typeof Native.existsSync>("node:fs")
export const globSync = createNotImplementedFunction<typeof Native.globSync>("node:fs")
export const lstatSync = createNotImplementedFunction<typeof Native.lstatSync>("node:fs")
export const mkdirSync = createNotImplementedFunction<typeof Native.mkdirSync>("node:fs")
export const mkdtempSync = createNotImplementedFunction<typeof Native.mkdtempSync>("node:fs")
export const openSync = createNotImplementedFunction<typeof Native.openSync>("node:fs")
export const promises = createNotImplementedFunction<typeof Native.promises>("node:fs")
export const readFileSync = createNotImplementedFunction<typeof Native.readFileSync>("node:fs")
export const readSync = createNotImplementedFunction<typeof Native.readSync>("node:fs")
export const readdirSync = createNotImplementedFunction<typeof Native.readdirSync>("node:fs")
export const readlinkSync = createNotImplementedFunction<typeof Native.readlinkSync>("node:fs")
export const realpathSync = createNotImplementedFunction<typeof Native.realpathSync>("node:fs")
export const renameSync = createNotImplementedFunction<typeof Native.renameSync>("node:fs")
export const rmSync = createNotImplementedFunction<typeof Native.rmSync>("node:fs")
export const rmdirSync = createNotImplementedFunction<typeof Native.rmdirSync>("node:fs")
export const statSync = createNotImplementedFunction<typeof Native.statSync>("node:fs")
export const symlinkSync = createNotImplementedFunction<typeof Native.symlinkSync>("node:fs")
export const unlinkSync = createNotImplementedFunction<typeof Native.unlinkSync>("node:fs")
export const utimesSync = createNotImplementedFunction<typeof Native.utimesSync>("node:fs")
export const writeFileSync = createNotImplementedFunction<typeof Native.writeFileSync>("node:fs")
export const writeSync = createNotImplementedFunction<typeof Native.writeSync>("node:fs")
