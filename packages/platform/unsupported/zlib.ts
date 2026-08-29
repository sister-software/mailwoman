import type * as Native from "node:zlib"

import { createNotImplementedFunction } from "../internal.ts"

export const crc32 = createNotImplementedFunction<typeof Native.crc32>("node:zlib")
export const gzipSync = createNotImplementedFunction<typeof Native.gzipSync>("node:zlib")
