/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { afterEach, describe, expect, test, vi } from "vitest"

import { CommandError, formatCommandError, reportError, runCLICommand } from "./command.ts"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("command errors", () => {
	test("expected guidance omits its stack", () => {
		const error = new CommandError("Set MAILWOMAN_WOF_DB")

		expect(error.stack).toContain("CommandError: Set MAILWOMAN_WOF_DB")
		expect(formatCommandError(error)).toBe("Set MAILWOMAN_WOF_DB")
	})

	test("reportError includes an attached cause", () => {
		const report = vi.spyOn(console, "error").mockImplementation(() => {})
		const cause = new Error("database header is corrupt")

		reportError(new CommandError("Cannot open gazetteer", { cause }))

		expect(report).toHaveBeenNthCalledWith(1, "Cannot open gazetteer")
		expect(report).toHaveBeenNthCalledWith(2, expect.stringContaining("database header is corrupt"))
	})

	test("runCLICommand reports unexpected stacks and returns exit code 1", async () => {
		const report = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(runCLICommand(() => Promise.reject(new Error("boom")))).resolves.toBe(1)
		expect(report).toHaveBeenCalledWith(expect.stringMatching(/Error: boom[\s\S]*command\.test/u))
	})
})
