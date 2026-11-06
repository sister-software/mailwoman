/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { bodyMatchesContentLength, tornBodyPlugin } from "#torn-body"

const MODEL = "https://public.example.test/en-us/10.8.0/model.onnx"

function respond(body: Uint8Array<ArrayBuffer>, headers: Record<string, string>): Response {
	return new Response(body, { headers })
}

describe("bodyMatchesContentLength", () => {
	test("passes a body whose length matches the header, and refuses a shorter or longer one", async () => {
		await expect(bodyMatchesContentLength(respond(new Uint8Array(100), { "content-length": "100" }))).resolves.toBe(
			true
		)

		await expect(bodyMatchesContentLength(respond(new Uint8Array(60), { "content-length": "100" }))).resolves.toBe(
			false
		)

		await expect(bodyMatchesContentLength(respond(new Uint8Array(120), { "content-length": "100" }))).resolves.toBe(
			false
		)
	})

	test("passes a response whose header cannot be checked against its body", async () => {
		await expect(bodyMatchesContentLength(respond(new Uint8Array(60), {}))).resolves.toBe(true)

		await expect(
			bodyMatchesContentLength(respond(new Uint8Array(60), { "content-length": "100", "content-encoding": "gzip" }))
		).resolves.toBe(true)
	})

	test("leaves the response's body readable", async () => {
		const response = respond(new Uint8Array(100), { "content-length": "100" })

		await bodyMatchesContentLength(response)

		expect((await response.arrayBuffer()).byteLength).toBe(100)
	})
})

describe("tornBodyPlugin", () => {
	test("cacheWillUpdate keeps a whole response and drops a torn one", async () => {
		const { cacheWillUpdate } = tornBodyPlugin()
		const whole = respond(new Uint8Array(100), { "content-length": "100" })
		const torn = respond(new Uint8Array(30), { "content-length": "100" })
		const event = {} as ExtendableEvent

		await expect(cacheWillUpdate!({ request: new Request(MODEL), response: whole, event })).resolves.toBe(whole)
		await expect(cacheWillUpdate!({ request: new Request(MODEL), response: torn, event })).resolves.toBeNull()
	})
})
