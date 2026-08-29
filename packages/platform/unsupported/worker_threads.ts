import type * as Native from "node:worker_threads"

import { createNotImplementedFunction } from "../internal.ts"

export const Worker = createNotImplementedFunction("node:worker_threads") as unknown as typeof Native.Worker

export type Worker = Native.Worker
export const parentPort = createNotImplementedFunction("node:worker_threads") as unknown as typeof Native.parentPort
export const workerData = createNotImplementedFunction("node:worker_threads") as unknown as typeof Native.workerData
