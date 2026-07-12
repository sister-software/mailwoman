/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node serve wrapper over `@hono/node-server`. The one place the node listener is created —
 *   surface packages stay web-standard (they only export `fetch`-shaped apps) so an edge
 *   deployment needs no changes to them.
 */

import { serve } from "@hono/node-server"

/** A `fetch`-shaped request handler (what `OpenAPIHono.fetch` provides). */
export type FetchLike = (request: Request, ...args: never[]) => Response | Promise<Response>

export interface ServeNodeOptions {
	fetch: FetchLike
	port: number
	hostname: string
	/** Called once the listener is bound — receives the actual port (useful with `port: 0`). */
	onListen?: (info: { port: number; address: string }) => void
}

export interface ServerHandle {
	close(): Promise<void>
}

/** Boot a node HTTP listener for a Hono app. Returns a handle whose `close()` resolves when the listener is down. */
export function serveNode(options: ServeNodeOptions): ServerHandle {
	const server = serve({ fetch: options.fetch as never, port: options.port, hostname: options.hostname }, (info) =>
		options.onListen?.({ port: info.port, address: info.address })
	)

	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error?: Error) => (error ? reject(error) : resolve()))
			}),
	}
}
