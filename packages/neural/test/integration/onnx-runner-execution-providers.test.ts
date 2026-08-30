/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The guarded execution-provider selection in ONNXRunner. ORT's GPU providers (cuda/webgpu) THROW at
 *   session-create when their runtime/driver is absent rather than soft-falling-back, so ONNXRunner
 *   retries on CPU. Mocks `ort.InferenceSession.create` — no model, no GPU needed.
 */

import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import ort from "onnxruntime-node"
import { afterEach, describe, expect, test, vi } from "vitest"

const fakeSession = () =>
	// `ort.InferenceSession` is onnxruntime's own class and this repo does not own its shape, so no double can be
	// assignable in either direction. The runner reads `inputNames` and `run`; those are what the fake supplies.
	({ inputNames: [], outputNames: [], run: async () => ({}) }) as unknown as ort.InferenceSession

const epsOf = (call: unknown[]) => (call[1] as { executionProviders: string[] }).executionProviders

describe("ONNXRunner execution providers (guarded)", () => {
	afterEach(() => vi.restoreAllMocks())

	test("defaults to cpu — a single create on [cpu]", async () => {
		const spy = vi.spyOn(ort.InferenceSession, "create").mockResolvedValue(fakeSession())

		await ONNXRunner.fromBytes(new Uint8Array([1]), { warmup: true })

		expect(spy).toHaveBeenCalledTimes(1)
		expect(epsOf(spy.mock.calls[0]!)).toEqual(["cpu"])
	})

	test("appends cpu as the final fallback to a GPU-only list", async () => {
		const spy = vi.spyOn(ort.InferenceSession, "create").mockResolvedValue(fakeSession())

		await ONNXRunner.fromBytes(new Uint8Array([1]), { warmup: true, executionProviders: ["webgpu"] })

		expect(epsOf(spy.mock.calls[0]!)).toEqual(["webgpu", "cpu"])
	})

	test("a GPU provider that throws at create is caught and retried on cpu alone", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})

		const spy = vi.spyOn(ort.InferenceSession, "create").mockImplementation(async (_bytes, opts) => {
			const eps = (opts?.executionProviders ?? []) as string[]

			if (eps.some((ep) => ep !== "cpu")) {
				throw new Error("Failed to load shared library libonnxruntime_providers_cuda.so")
			}

			return fakeSession()
		})

		const runner = await ONNXRunner.fromBytes(new Uint8Array([1]), {
			warmup: true,
			executionProviders: ["cuda", "cpu"],
		})

		expect(runner).toBeDefined()
		expect(spy).toHaveBeenCalledTimes(2)
		expect(epsOf(spy.mock.calls[0]!)).toEqual(["cuda", "cpu"]) // GPU attempt
		expect(epsOf(spy.mock.calls[1]!)).toEqual(["cpu"]) // guarded CPU retry
	})

	test("a genuine cpu failure is NOT swallowed by the guard", async () => {
		vi.spyOn(ort.InferenceSession, "create").mockRejectedValue(new Error("corrupt model"))

		await expect(ONNXRunner.fromBytes(new Uint8Array([1]), { warmup: true })).rejects.toThrow("corrupt model")
	})
})
