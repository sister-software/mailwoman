import type * as Native from "node:child_process"

import { createNotImplementedFunction } from "../internal.ts"

export const ChildProcess = createNotImplementedFunction("node:child_process") as unknown as typeof Native.ChildProcess

export type ChildProcess = Native.ChildProcess
export const execFile = createNotImplementedFunction("node:child_process") as unknown as typeof Native.execFile
export const execFileSync = createNotImplementedFunction("node:child_process") as unknown as typeof Native.execFileSync
export const execSync = createNotImplementedFunction("node:child_process") as unknown as typeof Native.execSync
export const fork = createNotImplementedFunction("node:child_process") as unknown as typeof Native.fork
export const spawn = createNotImplementedFunction("node:child_process") as unknown as typeof Native.spawn
export const spawnSync = createNotImplementedFunction("node:child_process") as unknown as typeof Native.spawnSync
