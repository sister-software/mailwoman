/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { streamingSha256 } from "#adapters/sha256-stream"

describe("streamingSha256", () => {
	it("matches a one-shot hash of the concatenated chunks", () => {
		const incremental = streamingSha256()
		incremental.update("hello, ")
		incremental.update("world")
		expect(incremental.digest()).toBe("09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b")
	})

	it("is idempotent on digest()", () => {
		const h = streamingSha256()
		h.update("abc")
		const first = h.digest()
		const second = h.digest()
		expect(first).toBe(second)
	})

	it("rejects update after digest", () => {
		const h = streamingSha256()
		h.update("abc")
		h.digest()
		expect(() => h.update("def")).toThrow(/after digest/)
	})
})
