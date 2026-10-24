/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { prettyJSON } from "@mailwoman/core/json"

import { CloudflareWorkerPMTiles } from "#protomaps"

/**
 * Root route: a plain identifying response, so a request to the Worker's origin answers 200.
 */
export function serveHome(): Response {
	return new Response(
		prettyJSON({
			id: "mailwoman-tile-api",
			timestamp: new Date().toISOString(),
			count: CloudflareWorkerPMTiles.SharedResolvedValueCache.counter,
		}),
		{
			headers: {
				"Content-Type": "application/json",
			},
		}
	)
}

/**
 * Liveness probe at `/heartbeat`, used by uptime checks.
 */
export function serveHeartbeat(): Response {
	return new Response("OK", {
		headers: {
			"Content-Type": "text/plain",
		},
	})
}
