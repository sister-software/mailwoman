/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fetchWithRetry } from "mailwoman/browser-runtime/fetch"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

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
	const outcome = work.then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	)

	await vi.runAllTimersAsync()

	const result = await outcome

	if ("error" in result) throw result.error

	return result.value
}

/**
 * A response whose body loses its connection partway through, which is how a mid-download reset reaches a reader.
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

describe("fetchWithRetry", () => {
	test("a network failure is retried and the later answer is returned", async () => {
		const impl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		expect(await answer.text()).toBe("ok")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("a connection lost while the body streams is retried, and the answer carries the whole body", async () => {
		const impl = vi.fn<typeof fetch>().mockResolvedValueOnce(resetMidBody()).mockResolvedValueOnce(new Response("ok"))

		vi.stubGlobal("fetch", impl)

		const answer = await settle(fetchWithRetry("https://example.test/model.onnx"))

		expect(await answer.text()).toBe("ok")
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

	test("a failure that is not a network failure is not retried", async () => {
		const impl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"))

		vi.stubGlobal("fetch", impl)

		await expect(settle(fetchWithRetry("https://example.test/model.onnx"))).rejects.toThrow("aborted")
		expect(impl).toHaveBeenCalledTimes(1)
	})
})
