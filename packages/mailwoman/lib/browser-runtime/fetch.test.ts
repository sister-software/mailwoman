// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { FetchStalledError, fetchWithRetry, STALL_TIMEOUT_MS, subscribeNetworkWaits } from "#browser-runtime/fetch"

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

/**
 * Drive a `fetchWithRetry` call to completion while the retry pauses are on fake timers.
 */
async function settle<T>(work: Promise<T>): Promise<T> {
	const settled = work.then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	)

	await vi.runAllTimersAsync()

	const result = await settled

	if ("error" in result) throw result.error

	return result.value
}

/**
 * A response whose body loses its connection partway through.
 * This is how a mid-download reset reaches a reader.
 */
function resetMidBody(): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"))
			controller.error(new TypeError("network error"))
		},
	})

	return new Response(body, { status: 200 })
}

/**
 * A request that stays pending until its signal aborts.
 * It then rejects with the abort reason, as a browser does.
 */
function silentUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
	})
}

/**
 * A body that delivers one chunk and then goes silent until its request's signal aborts.
 */
function bodyThatGoesSilent(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"))
			signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true })
		},
	})
}

/**
 * A body that delivers `chunks` single-byte chunks, each arriving one second inside the stall timeout.
 */
function slowBody(chunks: number): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (let i = 0; i < chunks; i++) {
				await new Promise((resolve) => {
					setTimeout(resolve, STALL_TIMEOUT_MS - 1000)
				})

				controller.enqueue(new TextEncoder().encode("x"))
			}

			controller.close()
		},
	})
}

describe("fetchWithRetry", () => {
	test("a network failure is retried and the later answer is returned", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		await expect(answer.text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("the first attempt keeps the caller's cache mode, and each retry runs in reload mode", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		await settle(fetchWithRetry("https://example.test/model.onnx", { credentials: "omit" }))

		expect(impl.mock.calls.map(([, init]) => init?.cache)).toEqual([undefined, "reload", "reload"])
		expect(impl.mock.calls.every(([, init]) => init?.credentials === "omit")).toBe(true)
	})

	test("a retry keeps a caller's no-store mode", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		await settle(fetchWithRetry("https://example.test/releases.json", { cache: "no-store" }))

		expect(impl.mock.calls.map(([, init]) => init?.cache)).toEqual(["no-store", "no-store"])
	})

	test("a connection lost while the body streams is retried, and the answer carries the whole body", async () => {
		const impl = vi.fn<typeof fetch>().mockResolvedValueOnce(resetMidBody()).mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		await expect(answer.text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("a network failure on every attempt is the caller's", async () => {
		const impl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))

		vi.stubGlobal("fetch", impl)

		await expect(settle(fetchWithRetry("https://example.test/model.onnx"))).rejects.toThrow("Failed to fetch")
		expect(impl).toHaveBeenCalledTimes(3)
	})

	test("an HTTP status is an answer, never a retry", async () => {
		const impl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))

		vi.stubGlobal("fetch", impl)

		expect((await settle(fetchWithRetry("https://example.test/absent.bin"))).status).toBe(404)
		expect(impl).toHaveBeenCalledTimes(1)
	})

	test("an attempt whose headers never arrive is aborted after the stall timeout and retried", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockImplementationOnce((_input, init) => silentUntilAborted(init?.signal))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		await expect(answer.text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("a body that stops delivering bytes is aborted and retried", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(async (_input, init) => new Response(bodyThatGoesSilent(init?.signal), { status: 200 }))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		await expect(answer.text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("a slow body that keeps delivering runs past the stall timeout to completion", async () => {
		const impl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(slowBody(4), { status: 200 }))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		await expect(answer.text()).resolves.toBe("xxxx")
		expect(impl).toHaveBeenCalledTimes(1)
	})

	test("a stall on every attempt rejects with the stall", async () => {
		const impl = vi.fn<typeof fetch>().mockImplementation((_input, init) => silentUntilAborted(init?.signal))

		vi.stubGlobal("fetch", impl)

		await expect(settle(fetchWithRetry("https://example.test/model.onnx"))).rejects.toBeInstanceOf(FetchStalledError)
		expect(impl).toHaveBeenCalledTimes(3)
	})

	test("a failure that is not a network failure is not retried", async () => {
		const impl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"))

		vi.stubGlobal("fetch", impl)

		await expect(settle(fetchWithRetry("https://example.test/model.onnx"))).rejects.toThrow("aborted")
		expect(impl).toHaveBeenCalledTimes(1)
	})
})

describe("fetchWithRetry while offline", () => {
	/**
	 * Stubs `navigator.onLine` and the window's `online` event, as a browser that
	 * lost its connection exposes them.
	 */
	function stubConnection(initiallyOnline: boolean) {
		const window = new EventTarget()
		const navigator = { onLine: initiallyOnline }

		vi.stubGlobal("navigator", navigator)
		vi.stubGlobal("addEventListener", window.addEventListener.bind(window))
		vi.stubGlobal("removeEventListener", window.removeEventListener.bind(window))

		return {
			goOffline: () => {
				navigator.onLine = false
			},
			goOnline: () => {
				navigator.onLine = true
				window.dispatchEvent(new Event("online"))
			},
		}
	}

	test("waits for a connection before its first attempt, and reports the wait", async () => {
		const connection = stubConnection(false)
		const impl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"))
		const waits: number[] = []
		const unsubscribe = subscribeNetworkWaits((waiting) => waits.push(waiting))

		vi.stubGlobal("fetch", impl)

		const answer = fetchWithRetry("https://example.test/model.onnx")

		await vi.advanceTimersByTimeAsync(60_000)
		expect(impl).not.toHaveBeenCalled()

		connection.goOnline()

		await expect((await answer).text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(1)
		expect(waits).toEqual([0, 1, 0])

		unsubscribe()
	})

	test("a failure while offline costs no attempt", async () => {
		const connection = stubConnection(true)

		const impl = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(async () => {
				connection.goOffline()

				throw new TypeError("Load failed")
			})
			.mockRejectedValueOnce(new TypeError("Load failed"))
			.mockRejectedValueOnce(new TypeError("Load failed"))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = fetchWithRetry("https://example.test/model.onnx")

		await vi.advanceTimersByTimeAsync(10_000)
		expect(impl).toHaveBeenCalledTimes(1)

		connection.goOnline()
		await vi.advanceTimersByTimeAsync(5000)

		await expect((await answer).text()).resolves.toBe("ok")

		// One offline failure, two counted failures, and the third counted attempt answers.
		expect(impl).toHaveBeenCalledTimes(4)
		expect(impl.mock.calls.slice(1).map(([, init]) => init?.cache)).toEqual(["reload", "reload", "reload"])
	})

	test("waits without a time limit, and fetches once the connection returns", async () => {
		const connection = stubConnection(false)
		const impl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"))
		let settled = false

		vi.stubGlobal("fetch", impl)

		const answer = fetchWithRetry("https://example.test/model.onnx").finally(() => {
			settled = true
		})

		// After two hours offline the call has made zero attempts and is still pending.
		await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
		expect(settled).toBe(false)
		expect(impl).not.toHaveBeenCalled()

		connection.goOnline()

		await expect((await answer).text()).resolves.toBe("ok")
		expect(impl).toHaveBeenCalledTimes(1)
	})

	test("a caller's abort ends the wait", async () => {
		stubConnection(false)
		vi.stubGlobal("fetch", vi.fn<typeof fetch>())

		const controller = new AbortController()

		const failure = fetchWithRetry("https://example.test/model.onnx", { signal: controller.signal }).catch(
			(error: unknown) => error
		)

		controller.abort(new DOMException("left the page", "AbortError"))

		expect(await failure).toMatchObject({ name: "AbortError" })
	})
})
