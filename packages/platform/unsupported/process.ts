import type * as Native from "node:process"

import { createNotImplementedFunction } from "../internal.ts"

const unsupportedDefault = createNotImplementedFunction<typeof Native>("node:process")
export default unsupportedDefault
