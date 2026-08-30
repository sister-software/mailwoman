import type * as Native from "node:os"

import { createNotImplementedFunction } from "../internal.ts"

export const arch = createNotImplementedFunction<typeof Native.arch>("node:os")

export const availableParallelism = createNotImplementedFunction<typeof Native.availableParallelism>("node:os")

export const cpus = createNotImplementedFunction<typeof Native.cpus>("node:os")
export const homedir = createNotImplementedFunction<typeof Native.homedir>("node:os")
export const platform = createNotImplementedFunction<typeof Native.platform>("node:os")
export const tmpdir = createNotImplementedFunction<typeof Native.tmpdir>("node:os")
export const totalmem = createNotImplementedFunction<typeof Native.totalmem>("node:os")
