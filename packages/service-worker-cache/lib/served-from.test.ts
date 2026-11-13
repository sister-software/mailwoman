// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { servedFromCachePlugin } from "#served-from"

const MODEL = "https://public.example.test/en-us/v10.8.0/model.onnx"
const event = {} as ExtendableEvent

describe("servedFromCachePlugin", () => {
	test("marks a stored response and keeps its status, headers and body", async () => {
		const { cachedResponseWillBeUsed } = servedFromCachePlugin("x-mw-served-from")

		const stored = new Response(new Uint8Array(100), {
			status: 200,
			headers: { "content-type": "application/octet-stream", "content-length": "100" },
		})

		const marked = (await cachedResponseWillBeUsed!({
			request: new Request(MODEL),
			cachedResponse: stored,
			cacheName: "release-assets",
			event,
		})) as Response

		expect(marked.status).toBe(200)
		expect(marked.headers.get("x-mw-served-from")).toBe("service-worker")
		expect(marked.headers.get("content-length")).toBe("100")
		expect((await marked.arrayBuffer()).byteLength).toBe(100)
	})

	test("passes a missing response through as null", async () => {
		const { cachedResponseWillBeUsed } = servedFromCachePlugin("x-mw-served-from")

		await expect(
			cachedResponseWillBeUsed!({ request: new Request(MODEL), cachedResponse: undefined, cacheName: "c", event })
		).resolves.toBeNull()
	})
})
