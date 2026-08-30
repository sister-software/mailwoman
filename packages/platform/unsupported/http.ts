import type * as Native from "node:http"

import { createNotImplementedFunction } from "../internal.ts"

export const IncomingMessage = createNotImplementedFunction<typeof Native.IncomingMessage>("node:http")

export type IncomingMessage = Native.IncomingMessage
export const Server = createNotImplementedFunction<typeof Native.Server>("node:http")

export type Server = Native.Server
export const ServerResponse = createNotImplementedFunction<typeof Native.ServerResponse>("node:http")

export type ServerResponse = Native.ServerResponse
export const createServer = createNotImplementedFunction<typeof Native.createServer>("node:http")
