/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { prettyJSON } from "@mailwoman/core/json"

import { CloudflareWorkerPMTiles } from "#protomaps/index"
import { WorkerRoute } from "#routing"

/**
 * Root route — a plain identifying response, so hitting the worker's origin is not a 404.
 */
export const HomeRoute = WorkerRoute.GET("/", () => {
	return new Response(
		prettyJSON({
			id: "nexus-api",
			timestamp: new Date().toISOString(),
			count: CloudflareWorkerPMTiles.SharedResolvedValueCache.counter,
		}),
		{
			headers: {
				"Content-Type": "application/json",
			},
		}
	)
})

/**
 * Liveness probe at `/heartbeat`, used by uptime checks.
 */
export const HealthCheckRoute = WorkerRoute.GET("/heartbeat", () => {
	return new Response("OK", {
		headers: {
			"Content-Type": "text/plain",
		},
	})
})
