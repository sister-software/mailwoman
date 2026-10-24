/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Hono } from "hono"

/**
 * A private service that answers the native Mailwoman API routes.
 */
export interface APIBackend {
	fetch(request: Request): Promise<Response>
}

const BACKEND_ORIGIN = "http://engine.internal"
const MAX_REQUEST_BYTES = 64 * 1024

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
 * Create the public Hono entry point around a private native API service.
 */
export function createAPIWorkerApp(backend: APIBackend): Hono {
	const app = new Hono()

	app.get("/health", async (c) => {
		try {
			const response = await backend.fetch(new Request(`${BACKEND_ORIGIN}/health`))

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
			return await backend.fetch(new Request(`${BACKEND_ORIGIN}${path}`, { method: "POST", headers, body }))
		} catch {
			return Response.json({ error: "backend unavailable" }, { status: 502 })
		}
	}

	app.post("/v1/parse", (c) => forward(c.req.raw, "/v1/parse"))
	app.post("/v1/geocode", (c) => forward(c.req.raw, "/v1/geocode"))

	return app
}
