import type * as Native from "node:os"

import { createNotImplementedFunction } from "../internal.ts"

export const arch = createNotImplementedFunction("node:os") as unknown as typeof Native.arch

export const availableParallelism = createNotImplementedFunction(
	"node:os"
) as unknown as typeof Native.availableParallelism

export const cpus = createNotImplementedFunction("node:os") as unknown as typeof Native.cpus
export const homedir = createNotImplementedFunction("node:os") as unknown as typeof Native.homedir
export const platform = createNotImplementedFunction("node:os") as unknown as typeof Native.platform
export const tmpdir = createNotImplementedFunction("node:os") as unknown as typeof Native.tmpdir
export const totalmem = createNotImplementedFunction("node:os") as unknown as typeof Native.totalmem
