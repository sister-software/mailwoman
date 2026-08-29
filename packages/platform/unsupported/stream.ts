import type * as Native from "node:stream"

import { createNotImplementedFunction } from "../internal.ts"

export const Readable = createNotImplementedFunction("node:stream") as unknown as typeof Native.Readable
