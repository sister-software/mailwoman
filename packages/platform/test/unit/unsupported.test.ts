import { NotImplementedError } from "@mailwoman/platform"
import { existsSync } from "@mailwoman/platform/fs"
import { createNotImplementedError, createNotImplementedFunction } from "@mailwoman/platform/internal"
import { describe, expect, it } from "vitest"

describe("platform capability boundaries", () => {
	it("selects the Node implementation under the Node condition", () => {
		expect(existsSync(import.meta.filename)).toBe(true)
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
