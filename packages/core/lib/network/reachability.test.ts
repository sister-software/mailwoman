// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { afterEach, describe, expect, test, vi } from "vitest"

import { ReachabilityProbe } from "#network/reachability"

const HEALTH = "https://api.example.test/health"

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("ReachabilityProbe", () => {
	test("requests the given route in cors mode without the HTTP cache", async () => {
		const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal("fetch", fetchStub)

		using probe = new ReachabilityProbe(HEALTH)

		await expect(probe.test()).resolves.toBe(true)
		expect(fetchStub).toHaveBeenCalledWith(HEALTH, expect.objectContaining({ mode: "cors", cache: "no-store" }))
	})

	test("reports a failing status, such as the API Worker's 503 for an unavailable backend, as unreachable", async () => {
		vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }))

		using probe = new ReachabilityProbe(HEALTH)

		await expect(probe.test()).resolves.toBe(false)
	})

	test("reports a network failure and a synchronous throw as unreachable", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch")
		})

		using probe = new ReachabilityProbe(HEALTH)

		await expect(probe.test()).resolves.toBe(false)

		vi.stubGlobal("fetch", () => {
			throw new TypeError("synchronous")
		})

		await expect(probe.test()).resolves.toBe(false)
	})

	test("a new test cancels the one in flight", async () => {
		vi.stubGlobal(
			"fetch",
			(_url: string, init: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					// `fetch` rejects at once on a signal that's already aborted.
					if (init.signal?.aborted) {
						reject(init.signal.reason)

						return
					}

					init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
					setTimeout(() => resolve(new Response(null, { status: 200 })), 20)
				})
		)

		using probe = new ReachabilityProbe(HEALTH)

		const first = probe.test()
		const second = probe.test()

		await expect(first).resolves.toBe(false)
		await expect(second).resolves.toBe(true)
	})

	test("times out a route that never answers", async () => {
		vi.stubGlobal(
			"fetch",
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
				})
		)

		using probe = new ReachabilityProbe(HEALTH)

		await expect(probe.test(10)).resolves.toBe(false)
	})
})
