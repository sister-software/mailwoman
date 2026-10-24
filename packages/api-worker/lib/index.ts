/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import { createAPIWorkerApp, type APIBackend } from "#app"

interface APIWorkerEnv {
	API_BACKEND?: APIBackend
}

const handler: ExportedHandler<APIWorkerEnv> = {
	fetch(request, env) {
		if (!env.API_BACKEND) {
			return Response.json({ error: "backend binding unavailable" }, { status: 503 })
		}

		return createAPIWorkerApp(env.API_BACKEND).fetch(request)
	},
}

export default handler
