/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The public Hono entry point around a private native API service. The Worker admits a request, forwards the
 *   native parse and geocode routes to the backend with a deadline, and relays the backend's status, body and
 *   engine headers unchanged.
 */

import { Hono } from "hono"

import { MAX_REQUEST_BODY_BYTES, readBoundedBody } from "#body"
import { mailwomanCORS } from "#cors"
import { jsonError } from "#errors"

/**
 * A private service that answers the native Mailwoman API routes.
 */
export interface APIBackend {
	fetch(request: Request): Promise<Response>
}

/**
 * Options for {@link createAPIWorkerApp}.
 */
export interface APIWorkerOptions {
	/**
	 * How long a backend request may take before the Worker answers 504.
	 *
	 * @defaultValue 10 seconds
	 */
	deadlineMs?: number
}

const BACKEND_ORIGIN = "http://engine.internal"
const DEFAULT_DEADLINE_MS = 10_000

/**
 * The request headers the Worker forwards to the backend.
 * Every other header, such as a cookie, stays at the Worker.
 */
const FORWARDED_HEADERS = ["accept", "content-type", "x-request-id"] as const

/**
 * A backend that forwards to an HTTP origin, such as a `mailwoman serve` host.
 */
export function createOriginBackend(origin: URL): APIBackend {
	return {
		fetch(request) {
			const { pathname, search } = new URL(request.url)

			return fetch(new Request(new URL(`${pathname}${search}`, origin), request))
		},
	}
}

/**
 * Copy a backend response with mutable headers and without the backend's CORS policy.
 *
 * `mailwoman serve` answers every origin.
 * The Worker's CORS middleware sets the public policy on the copy.
 */
function relayResponse(response: Response): Response {
	const relayed = new Response(response.body, response)

	// Iterate the source headers, because deleting from the headers being iterated skips entries.
	for (const name of response.headers.keys()) {
		if (name.startsWith("access-control-")) {
			relayed.headers.delete(name)
		}
	}

	return relayed
}

function isTimeout(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError"
}

/**
 * Create the public Hono entry point around a private native API service.
 */
export function createAPIWorkerApp(backend: APIBackend, options: APIWorkerOptions = {}): Hono {
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
	const app = new Hono()

	app.use(
		mailwomanCORS({
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["content-type", "accept", "x-request-id"],
			exposeHeaders: ["server", "link"],
		})
	)

	app.get("/health", async (c) => {
		try {
			const response = await backend.fetch(
				new Request(`${BACKEND_ORIGIN}/health`, { signal: AbortSignal.timeout(deadlineMs) })
			)

			return c.json({ worker: "ready", backend: response.ok ? "ready" : "unavailable" }, response.ok ? 200 : 503)
		} catch {
			return c.json({ worker: "ready", backend: "unavailable" }, 503)
		}
	})

	async function forward(request: Request, path: string): Promise<Response> {
		const body = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES)

		if (!body) return jsonError(413, "request body too large")

		const headers = new Headers()

		for (const name of FORWARDED_HEADERS) {
			const value = request.headers.get(name)

			if (value != null) {
				headers.set(name, value)
			}
		}

		try {
			const response = await backend.fetch(
				new Request(`${BACKEND_ORIGIN}${path}`, {
					method: "POST",
					headers,
					body,
					signal: AbortSignal.timeout(deadlineMs),
				})
			)

			return relayResponse(response)
		} catch (error) {
			if (isTimeout(error)) return jsonError(504, "backend timeout")

			return jsonError(502, "backend unavailable")
		}
	}

	app.post("/v1/parse", (c) => forward(c.req.raw, "/v1/parse"))
	app.post("/v1/geocode", (c) => forward(c.req.raw, "/v1/geocode"))

	return app
}
