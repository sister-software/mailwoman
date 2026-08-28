/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

const HOOK_PATH = fileURLToPath(new URL("../../hooks/vale-response-check.ts", import.meta.url))

function runHook(lastAssistantMessage: string, stopHookActive = false): string {
	const result = spawnSync(process.execPath, [HOOK_PATH], {
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
