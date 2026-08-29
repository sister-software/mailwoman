import type * as Native from "node:https"

import { createNotImplementedFunction } from "../internal.ts"

export const get = createNotImplementedFunction("node:https") as unknown as typeof Native.get
