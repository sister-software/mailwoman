import { describe, expect, it } from "vitest"

import { formatPostfachNumber } from "#de/postfach"

describe("formatPostfachNumber", () => {
	it("writes the cited example's pairs", () => {
		expect(formatPostfachNumber("106438")).toBe("10 64 38")
	})

	it("refuses a length the cited page does not show", () => {
		expect(() => formatPostfachNumber("12345")).toThrow(/six digits/u)
	})
})
