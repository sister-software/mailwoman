/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node serve wrapper over `@hono/node-server`. The one place the node listener is created —
 *   surface packages stay web-standard (they only export `fetch`-shaped apps) so an edge
 *   deployment needs no changes to them.
 */

import { serve, type ServerType } from "@hono/node-server"

/**
 * A `fetch`-shaped request handler (what `OpenAPIHono.fetch` provides).
 */
export type FetchLike = (request: Request, ...args: never[]) => Response | Promise<Response>

/**
 * Options for `serveNode()`. Extracted since Hono doesn't seem to export them.
 */
export type ServeNodeOptions = Parameters<typeof serve>[0] & {
	/**
	 * Called once the listener is bound — receives the actual port (useful with `port: 0`).
	 */
	onListen?: (info: { port: number; address: string }) => void
}

export type ServerHandle = ServerType &
	AsyncDisposable & {
		readonly port: number
		readonly address: string
	}

const defaultOnListen = ({ port, address }: { port: number; address: string }) =>
	console.error(`[mailwoman] native /v1 API listening on http://${address}:${port}`)

/**
 * Boot a node HTTP listener for a Hono app. Returns an async-disposable handle once the listener is ready.
 */
export function serveNode({ onListen = defaultOnListen, ...options }: ServeNodeOptions): Promise<ServerHandle> {
	return new Promise<ServerHandle>((resolve, reject) => {
		const server = serve(options, (info) => {
			server.off("error", reject)

			Object.defineProperties(server, {
				port: { value: info.port, writable: false },
				address: { value: info.address, writable: false },
			})

			try {
				onListen(info)
				resolve(server as ServerHandle)
			} catch (error) {
				void server[Symbol.asyncDispose]().then(() => reject(error), reject)
			}
		})

		server.once("error", reject)
	})
}
