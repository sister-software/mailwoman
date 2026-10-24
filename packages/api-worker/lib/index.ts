/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"

import type { RequestLimiter } from "#admission"
import { createAPIWorkerApp, createOriginBackend, type APIBackend } from "#app"

interface APIWorkerEnv {
	/**
	 * A service binding to the engine, which takes precedence over {@link APIWorkerEnv.ENGINE_ORIGIN}.
	 */
	API_BACKEND?: APIBackend
	/**
	 * The HTTP origin of a `mailwoman serve` host, such as `http://127.0.0.1:3000` under `wrangler dev`.
	 */
	ENGINE_ORIGIN?: string
	/**
	 * The per-client request budget, the `[[ratelimits]]` binding in `wrangler.toml`.
	 */
	LIMITER?: RequestLimiter
}

/**
 * The window of the `LIMITER` binding in seconds, as `wrangler.toml` declares it.
 */
const LIMIT_PERIOD_SECONDS = 60

function backendFor(env: APIWorkerEnv): APIBackend | null {
	if (env.API_BACKEND) return env.API_BACKEND

	if (env.ENGINE_ORIGIN) return createOriginBackend(new URL(env.ENGINE_ORIGIN))

	return null
}

const handler: ExportedHandler<APIWorkerEnv> = {
	fetch(request, env) {
		const backend = backendFor(env)

		if (!backend) {
			return Response.json({ error: "backend binding unavailable" }, { status: 503 })
		}

		return createAPIWorkerApp(backend, {
			...(env.LIMITER ? { limiter: env.LIMITER } : {}),
			limitPeriodSeconds: LIMIT_PERIOD_SECONDS,
		}).fetch(request)
	},
}

export default handler
