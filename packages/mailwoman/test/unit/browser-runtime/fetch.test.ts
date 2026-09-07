/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fetchWithRetry } from "mailwoman/browser-runtime/fetch"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("fetchWithRetry", () => {
	test("a network failure is retried once and the second answer is returned", async () => {
		const answer = new Response("ok")

		const impl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(answer)

		vi.stubGlobal("fetch", impl)

		expect(await fetchWithRetry("https://example.test/model.onnx")).toBe(answer)
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("a second network failure is the caller's", async () => {
		const impl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))

		vi.stubGlobal("fetch", impl)

		await expect(fetchWithRetry("https://example.test/model.onnx")).rejects.toThrow("Failed to fetch")
		expect(impl).toHaveBeenCalledTimes(2)
	})

	test("an HTTP status is an answer, never a retry", async () => {
		const impl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))

		vi.stubGlobal("fetch", impl)

		expect((await fetchWithRetry("https://example.test/absent.bin")).status).toBe(404)
		expect(impl).toHaveBeenCalledTimes(1)
	})

	test("a failure that is not a network failure is not retried", async () => {
		const impl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"))

		vi.stubGlobal("fetch", impl)

		await expect(fetchWithRetry("https://example.test/model.onnx")).rejects.toThrow("aborted")
		expect(impl).toHaveBeenCalledTimes(1)
	})
})
