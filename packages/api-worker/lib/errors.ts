/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Error responses for the Workers. A Worker's own failure answers JSON with a status that identifies it, so a
 *   client can tell a refused request, an unavailable backend and a server fault apart without reading prose.
 */

import { ResourceError } from "@mailwoman/core/errors"
import { prettyJSON } from "@mailwoman/core/json"

/**
 * A JSON error response, `{ "error": <message> }`, with `status`.
 *
 * `headers` adds response headers, such as `Retry-After` on a 429.
 */
export function jsonError(status: number, error: string, headers?: HeadersInit): Response {
	return Response.json({ error }, { status, headers })
}

/**
 * The response for an error a Worker route threw.
 *
 * A {@link ResourceError} answers its own status with its JSON form: `name`, `status` and `message`.
 * Any other error is a fault in the Worker, logged and answered 500 with a fixed
 * message, so its text never reaches a client.
 */
export function renderWorkerError(error: unknown): Response {
	if (error instanceof ResourceError) {
		return new Response(prettyJSON(error), {
			status: error.status,
			headers: { "Content-Type": "application/json" },
		})
	}

	console.error(error)

	return new Response("Mailwoman Internal Server Error", { status: 500 })
}
