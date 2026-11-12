// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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

	test("checks a response without Content-Length against the expected-length lookup", async () => {
		const lookups: string[] = []

		const { cacheWillUpdate } = tornBodyPlugin({
			expectedLength: (request) => {
				lookups.push(request.url)

				return 100
			},
		})

		const event = {} as ExtendableEvent
		const whole = respond(new Uint8Array(100), {})
		const torn = respond(new Uint8Array(30), {})

		await expect(cacheWillUpdate!({ request: new Request(MODEL), response: whole, event })).resolves.toBe(whole)
		await expect(cacheWillUpdate!({ request: new Request(MODEL), response: torn, event })).resolves.toBeNull()
		expect(lookups).toEqual([MODEL, MODEL])
	})

	test("prefers a checkable Content-Length to the lookup, and stores a response the lookup has no length for", async () => {
		const { cacheWillUpdate } = tornBodyPlugin({ expectedLength: (request) => (request.url === MODEL ? 999 : null) })
		const event = {} as ExtendableEvent
		const declared = respond(new Uint8Array(100), { "content-length": "100" })
		const unknown = respond(new Uint8Array(30), {})

		await expect(cacheWillUpdate!({ request: new Request(MODEL), response: declared, event })).resolves.toBe(declared)

		await expect(cacheWillUpdate!({ request: new Request(`${MODEL}.other`), response: unknown, event })).resolves.toBe(
			unknown
		)
	})
})
