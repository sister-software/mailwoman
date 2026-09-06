// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { CloudflareWorkerPMTiles } from "#protomaps/index"
import { WorkerRoute } from "#routing"

/**
 * Root route — a plain identifying response, so hitting the worker's origin is not a 404.
 */
export const HomeRoute = WorkerRoute.GET("/", () => {
	return new Response(
		JSON.stringify(
			{
				id: "mailwoman-api",
				timestamp: new Date().toISOString(),
				count: CloudflareWorkerPMTiles.SharedResolvedValueCache.counter,
			},
			null,
			"\t"
		),
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
