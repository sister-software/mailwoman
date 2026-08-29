import type * as Native from "node:cluster"

import { createNotImplementedFunction } from "../internal.ts"

export const Worker = createNotImplementedFunction<typeof Native.Worker>("node:cluster")

export type Worker = Native.Worker

const unsupportedDefault = createNotImplementedFunction<typeof Native>("node:cluster")
export default unsupportedDefault
