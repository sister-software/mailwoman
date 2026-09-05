/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Two stand-ins for Stripe. `signedWebhook` signs a payload the way Stripe's destination does, so the verifier under
 *   test sees a real `Stripe-Signature`. `stripeFetch` is a fetch the SDK's HTTP client calls instead of the network:
 *   `routes` maps `GET /v1/invoices/in_1`-style keys to JSON bodies. An object path matches exactly, so `in_1` never
 *   answers for `in_1b`; a list key ends in `?` and matches by prefix, whatever the query. Anything else is a 404 the
 *   SDK raises as an error, so an unexpected retrieval is loud rather than silently absent.
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

export function stripeFetch(routes: Record<string, unknown>): typeof fetch {
	const entries = Object.entries(routes).map(([key, body]) => {
		const [method, path] = key.split(" ") as [string, string]

		return { method, path, body }
	})

	return async (input, init) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		const target = `${url.pathname}${url.search}`

		const route = entries.find(
			(entry) =>
				entry.method === request.method &&
				(entry.path.endsWith("?") ? target.startsWith(entry.path) : url.pathname === entry.path)
		)

		if (!route) {
			return Response.json(
				{ error: { type: "invalid_request_error", message: `no fixture for ${request.method} ${target}` } },
				{ status: 404 }
			)
		}

		return Response.json(route.body, { headers: { "request-id": "req_fixture" } })
	}
}
