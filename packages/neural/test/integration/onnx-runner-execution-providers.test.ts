import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import ort from "onnxruntime-node"
import { afterEach, describe, expect, test, vi } from "vitest"

const fakeSession = (): ort.InferenceSession => {
	return {
		run(): Promise<ort.InferenceSession.ReturnType> {
			throw new Error("Function not implemented.")
		},
		release(): Promise<void> {
			throw new Error("Function not implemented.")
		},
		startProfiling(): void {
			throw new Error("Function not implemented.")
		},
		endProfiling(): void {
			throw new Error("Function not implemented.")
		},
		inputNames: [],
		outputNames: [],
		inputMetadata: [],
		outputMetadata: [],
	}
}

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
		expect(epsOf(spy.mock.calls[0]!)).toEqual(["cuda", "cpu"])
		expect(epsOf(spy.mock.calls[1]!)).toEqual(["cpu"])
	})

	test("A genuine cpu failure is NOT swallowed by the condition", async () => {
		vi.spyOn(ort.InferenceSession, "create").mockRejectedValue(new Error("corrupt model"))

		await expect(ONNXRunner.fromBytes(new Uint8Array([1]), { warmup: true })).rejects.toThrow("corrupt model")
	})
})
