import type * as Native from "node:process"

import { createNotImplementedFunction } from "../internal.ts"

const unsupportedDefault = createNotImplementedFunction("node:process") as unknown as typeof Native
export default unsupportedDefault
