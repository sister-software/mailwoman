import type * as Native from "node:worker_threads"

import { createNotImplementedFunction } from "../internal.ts"

export const workerData = createNotImplementedFunction("node:worker_threads") as unknown as typeof Native.workerData
