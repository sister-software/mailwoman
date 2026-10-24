/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Hono } from "hono"
import { cors } from "hono/cors"

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
const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_DEADLINE_MS = 10_000

/**
 * The browser origins that may call the Worker.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
	"https://earth.mailwoman.ai",
	"https://mailwoman.ai",
	"https://dev.mailwoman.ai",
	"https://dev.mailwoman.ai:7777",
	"https://dev.mailwoman.ai:8888",
])

const LOCALHOST_PATTERN = /^https?:\/\/(([a-z0-9]+\.)?localhost|127\.0\.0\.1)(:\d{2,5})?$/i

function allowedOrigin(origin: string): string | null {
	return ALLOWED_ORIGINS.has(origin) || LOCALHOST_PATTERN.test(origin) ? origin : null
}

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

async function readRequestBody(request: Request): Promise<ArrayBuffer | null> {
	const reader = request.body?.getReader()

	if (!reader) return new ArrayBuffer(0)

	const chunks: Uint8Array[] = []
	let length = 0

	while (true) {
		const { done, value } = await reader.read()

		if (done) break

		length += value.byteLength

		if (length > MAX_REQUEST_BYTES) {
			await reader.cancel()

			return null
		}

		chunks.push(value)
	}

	const bytes = new Uint8Array(length)
	let offset = 0

	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}

	return bytes.buffer
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
		cors({
			origin: allowedOrigin,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: ["content-type", "accept", "x-request-id"],
			exposeHeaders: ["server", "link"],
			maxAge: 86_400,
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
		const body = await readRequestBody(request)

		if (!body) return Response.json({ error: "request body too large" }, { status: 413 })

		const headers = new Headers()

		for (const name of ["accept", "content-type", "x-request-id"]) {
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
			if (isTimeout(error)) return Response.json({ error: "backend timeout" }, { status: 504 })

			return Response.json({ error: "backend unavailable" }, { status: 502 })
		}
	}

	app.post("/v1/parse", (c) => forward(c.req.raw, "/v1/parse"))
	app.post("/v1/geocode", (c) => forward(c.req.raw, "/v1/geocode"))

	return app
}
