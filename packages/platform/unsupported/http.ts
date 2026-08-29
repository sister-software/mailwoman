import type * as Native from "node:http"

import { createNotImplementedFunction } from "../internal.ts"

export const IncomingMessage = createNotImplementedFunction("node:http") as unknown as typeof Native.IncomingMessage
export const Server = createNotImplementedFunction("node:http") as unknown as typeof Native.Server
export const ServerResponse = createNotImplementedFunction("node:http") as unknown as typeof Native.ServerResponse
export const createServer = createNotImplementedFunction("node:http") as unknown as typeof Native.createServer
