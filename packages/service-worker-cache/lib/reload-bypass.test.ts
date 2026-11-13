// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"
import type { MapLikeObject } from "workbox-core/types.js"

import { reloadBypassPlugin, requestsNetworkCopy } from "#reload-bypass"

const MODEL = "https://public.example.test/en-us/v10.8.0/model.onnx"
const CACHE_NAME = "release-assets-test"
const event = {} as ExtendableEvent

describe("requestsNetworkCopy", () => {
	test("reads reload and no-store as a request for the network copy", () => {
		expect(requestsNetworkCopy(new Request(MODEL, { cache: "reload" }))).toBe(true)
		expect(requestsNetworkCopy(new Request(MODEL, { cache: "no-store" }))).toBe(true)
		expect(requestsNetworkCopy(new Request(MODEL))).toBe(false)
		expect(requestsNetworkCopy(new Request(MODEL, { cache: "force-cache" }))).toBe(false)
	})
})

describe("reloadBypassPlugin", () => {
	test("answers a default-mode request with the stored copy", async () => {
		const { cachedResponseWillBeUsed } = reloadBypassPlugin()
		const stored = new Response("stored")

		await expect(
			cachedResponseWillBeUsed!({ request: new Request(MODEL), cachedResponse: stored, cacheName: CACHE_NAME, event })
		).resolves.toBe(stored)
	})

	test("passes over the stored copy for a reload, and answers with it when the network then fails", async () => {
		const { cachedResponseWillBeUsed, handlerDidError } = reloadBypassPlugin()
		const stored = new Response("stored")
		const state: MapLikeObject = {}
		const request = new Request(MODEL, { cache: "reload" })

		await expect(
			cachedResponseWillBeUsed!({ request, cachedResponse: stored, cacheName: CACHE_NAME, event, state })
		).resolves.toBeNull()

		await expect(handlerDidError!({ request, error: new TypeError("offline"), event, state })).resolves.toBe(stored)
	})

	test("has no fallback for a request that found no stored copy", async () => {
		const { cachedResponseWillBeUsed, handlerDidError } = reloadBypassPlugin()
		const state: MapLikeObject = {}
		const request = new Request(MODEL, { cache: "reload" })

		await expect(
			cachedResponseWillBeUsed!({ request, cachedResponse: undefined, cacheName: CACHE_NAME, event, state })
		).resolves.toBeNull()

		await expect(handlerDidError!({ request, error: new TypeError("offline"), event, state })).resolves.toBeUndefined()
	})
})
