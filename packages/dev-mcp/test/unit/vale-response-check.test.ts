/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { spawnProcessSync } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

const HOOK_PATH = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "vale-response-check.ts")

function runHook(lastAssistantMessage: string, stopHookActive = false): string {
	const result = spawnProcessSync(process.execPath, [HOOK_PATH], {
		input: JSON.stringify({ last_assistant_message: lastAssistantMessage, stop_hook_active: stopHookActive }),
		encoding: "utf8",
	})

	expect(result.status).toBe(0)
	expect(result.stderr).toBe("")

	return result.stdout
}

describe("Claude Vale Stop hook", () => {
	it("is silent for a clean reply", () => {
		expect(runHook("The test passed.")).toBe("")
	})

	it("uses the Stop schema's systemMessage for advisory findings", () => {
		const output = parseJSONStrict(runHook("The powerful model returned a result."))

		expect(output).toEqual({
			systemMessage: expect.stringContaining("advisory finding"),
		})
	})

	it("blocks on error findings", () => {
		const output = parseJSONStrict(runHook("The robust model returned a result."))

		expect(output).toEqual({
			decision: "block",
			reason: expect.stringContaining("Rewrite only the flagged sentences"),
		})
	})

	it("is silent during the corrective turn", () => {
		expect(runHook("The robust model returned a result.", true)).toBe("")
	})
})
