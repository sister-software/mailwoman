import { describe, expect, it } from "vitest"

import { isCITestSuite, readCITestArguments } from "#repo-health/ci/test"

describe("readCITestArguments", () => {
	it("passes selected files to the requested root suite", () => {
		expect(readCITestArguments("fast", '["packages/core/lib/path.test.ts"]', "false")).toEqual([
			"ci:test:fast",
			"packages/core/lib/path.test.ts",
		])
	})

	it("allows an empty file list only for a full run", () => {
		expect(readCITestArguments("slow", "[]", "true")).toEqual(["ci:test:slow"])
		expect(() => readCITestArguments("slow", "[]", "false")).toThrow("A scoped slow job requires selected test files")
	})

	it("rejects malformed and non-string file lists", () => {
		expect(() => readCITestArguments("fast", "not JSON")).toThrow("Failed to parse JSON")
		expect(() => readCITestArguments("fast", "[1]")).toThrow("expected string, received number")
	})
})

it("admits only the fast and slow suites", () => {
	expect(isCITestSuite("fast")).toBe(true)
	expect(isCITestSuite("slow")).toBe(true)
	expect(isCITestSuite("full")).toBe(false)
	expect(isCITestSuite(undefined)).toBe(false)
})
