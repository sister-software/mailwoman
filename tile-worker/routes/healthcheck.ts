// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { CloudflareWorkerPMTiles } from "../protomaps/index.ts"
import { WorkerRoute } from "../routing.ts"

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

export const HealthCheckRoute = WorkerRoute.GET("/heartbeat", () => {
	return new Response("OK", {
		headers: {
			"Content-Type": "text/plain",
		},
	})
})
