import type * as Native from "node:cluster"

import { createNotImplementedFunction } from "../internal.ts"

export const Worker = createNotImplementedFunction("node:cluster") as unknown as typeof Native.Worker

const unsupportedDefault = createNotImplementedFunction("node:cluster") as unknown as typeof Native
export default unsupportedDefault
