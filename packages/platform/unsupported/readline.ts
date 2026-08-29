import type * as Native from "node:readline"

import { createNotImplementedFunction } from "../internal.ts"

export const createInterface = createNotImplementedFunction("node:readline") as unknown as typeof Native.createInterface
