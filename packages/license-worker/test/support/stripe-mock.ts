/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Two stand-ins for Stripe. `signedWebhook` signs a payload the way Stripe's destination does, so the verifier under
 *   test sees a real `Stripe-Signature`. `mockStripe` intercepts `api.stripe.com` through Miniflare's fetch mock: `routes`
 *   maps `GET /v1/invoices/in_1`-style keys to JSON bodies, and anything else is a 404 the test sees as a failure, so an
 *   unexpected retrieval is loud rather than silently absent.
 */

import { fetchMock } from "cloudflare:test"

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

export function mockStripe(routes: Record<string, unknown>): void {
	fetchMock.activate()
	fetchMock.disableNetConnect()

	const origin = fetchMock.get("https://api.stripe.com")

	for (const [key, body] of Object.entries(routes)) {
		const [method, path] = key.split(" ") as [string, string]

		origin
			.intercept({ method, path: (actual) => actual.startsWith(path) })
			.reply(200, JSON.stringify(body), { headers: { "content-type": "application/json" } })
			.persist()
	}
}
