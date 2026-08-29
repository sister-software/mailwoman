import type * as Native from "node:zlib"

import { createNotImplementedFunction } from "../internal.ts"

export const crc32 = createNotImplementedFunction("node:zlib") as unknown as typeof Native.crc32
export const createGunzip = createNotImplementedFunction("node:zlib") as unknown as typeof Native.createGunzip
export const gunzipSync = createNotImplementedFunction("node:zlib") as unknown as typeof Native.gunzipSync
export const gzipSync = createNotImplementedFunction("node:zlib") as unknown as typeof Native.gzipSync
