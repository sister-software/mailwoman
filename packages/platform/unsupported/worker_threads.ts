import type * as Native from "node:worker_threads"

import { createNotImplementedFunction } from "../internal.ts"

export const Worker = createNotImplementedFunction<typeof Native.Worker>("node:worker_threads")

export type Worker = Native.Worker
export const parentPort = createNotImplementedFunction<typeof Native.parentPort>("node:worker_threads")
export const workerData = createNotImplementedFunction<typeof Native.workerData>("node:worker_threads")
