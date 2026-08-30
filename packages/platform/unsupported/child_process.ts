import type * as Native from "node:child_process"

import { createNotImplementedFunction } from "../internal.ts"

export const ChildProcess = createNotImplementedFunction<typeof Native.ChildProcess>("node:child_process")

export type ChildProcess = Native.ChildProcess
export const execFile = createNotImplementedFunction<typeof Native.execFile>("node:child_process")
export const execFileSync = createNotImplementedFunction<typeof Native.execFileSync>("node:child_process")
export const execSync = createNotImplementedFunction<typeof Native.execSync>("node:child_process")
export const fork = createNotImplementedFunction<typeof Native.fork>("node:child_process")
export const spawn = createNotImplementedFunction<typeof Native.spawn>("node:child_process")
export const spawnSync = createNotImplementedFunction<typeof Native.spawnSync>("node:child_process")
