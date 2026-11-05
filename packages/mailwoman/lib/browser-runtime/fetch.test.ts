/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { FetchStalledError, fetchWithRetry, STALL_TIMEOUT_MS } from "#browser-runtime/fetch"

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
