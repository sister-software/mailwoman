import { pathExists } from "@mailwoman/core/fs/readers"
import { NotImplementedError } from "@mailwoman/platform"
import { createNotImplementedError, createNotImplementedFunction } from "@mailwoman/platform/internal"
import { describe, expect, it } from "vitest"

describe("platform capability boundaries", () => {
	it("selects the Node implementation under the Node condition", async () => {
		expect(await pathExists(import.meta.filename)).toBe(true)
	})

	it("creates a named error carrying the unavailable package", () => {
		const error = createNotImplementedError("node:fs")

		expect(error).toBeInstanceOf(NotImplementedError)
		expect(error.name).toBe("NotImplementedError")
		expect(error.message).toContain("node:fs")
	})

	it("defers unsupported failures until the capability is invoked", () => {
		const unsupportedExistsSync = createNotImplementedFunction("node:fs")

		expect(unsupportedExistsSync).toBeTypeOf("function")
		expect(() => unsupportedExistsSync()).toThrow(NotImplementedError)
		expect(() => Reflect.get(unsupportedExistsSync, "anything")).toThrow(NotImplementedError)
	})
})
