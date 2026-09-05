/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Two stand-ins for Stripe. `signedWebhook` signs a payload the way Stripe's destination does, so the verifier under
 *   test sees a real `Stripe-Signature`. `stripeFetch` is a fetch the SDK's HTTP client calls instead of the network:
 *   `routes` maps `GET /v1/invoices/in_1`-style keys to JSON bodies, or to functions of the request's form body for a
 *   write. An object path matches exactly, so `in_1` never answers for `in_1b`; a list key ends in `?` and matches by
 *   prefix, whatever the query. Anything else is a 404 the SDK raises as an error, so an unexpected retrieval is loud
 *   rather than silently absent. `recordingStripeFetch` is the same with every request written down, for a test that
 *   asserts what was and was not sent. A route whose body carries an `error` key answers 400, as Stripe does.
 */

export async function signedWebhook(
	payload: object,
	secret: string,
	timestamp = Math.floor(Date.now() / 1000)
): Promise<{ body: string; signature: string }> {
	const body = JSON.stringify(payload)
	const encoder = new TextEncoder()

	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	])

	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)))
	const v1 = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")

	return { body, signature: `t=${timestamp},v1=${v1}` }
}

/**
 * A fixed JSON body, or a body computed from the request's form fields (a write's parameters, a list's query).
 */
export type StripeRoute = Record<string, unknown> | ((form: URLSearchParams) => unknown)

export interface RecordedStripeCall {
	method: string
	path: string
	form: URLSearchParams
}

export interface RecordingStripeFetch {
	fetch: typeof fetch
	calls: RecordedStripeCall[]
}

const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404

function isErrorBody(body: unknown): body is { error: unknown } {
	return typeof body === "object" && body !== null && "error" in body
}

export function recordingStripeFetch(routes: Record<string, StripeRoute>): RecordingStripeFetch {
	const entries = Object.entries(routes).map(([key, body]) => {
		const [method, path] = key.split(" ") as [string, string]

		return { method, path, body }
	})

	const calls: RecordedStripeCall[] = []

	const fetchStripe: typeof fetch = async (input, init) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		const target = `${url.pathname}${url.search}`
		const form = new URLSearchParams(request.method === "GET" ? url.search : await request.text())

		calls.push({ method: request.method, path: url.pathname, form })

		const route = entries.find(
			(entry) =>
				entry.method === request.method &&
				(entry.path.endsWith("?") ? target.startsWith(entry.path) : url.pathname === entry.path)
		)

		if (!route) {
			return Response.json(
				{ error: { type: "invalid_request_error", message: `no fixture for ${request.method} ${target}` } },
				{ status: HTTP_NOT_FOUND }
			)
		}

		const body = typeof route.body === "function" ? route.body(form) : route.body
		const status = isErrorBody(body) ? HTTP_BAD_REQUEST : undefined

		return Response.json(body, { ...(status ? { status } : {}), headers: { "request-id": "req_fixture" } })
	}

	return { fetch: fetchStripe, calls }
}

export function stripeFetch(routes: Record<string, StripeRoute>): typeof fetch {
	return recordingStripeFetch(routes).fetch
}
