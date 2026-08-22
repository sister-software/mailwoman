/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { tryParsingJSON } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

const HOOK = fileURLToPath(import.meta.resolve("../../hooks/symbol-precheck.ts"))
const REPO_ROOT = fileURLToPath(import.meta.resolve("../../../../"))

interface HookOutput {
	hookSpecificOutput?: {
		hookEventName?: string
		additionalContext?: string
	}
}

/**
 * Drive the hook exactly as the harness does: one JSON payload on stdin, one JSON document on stdout.
 */
function runHook(payload: unknown): HookOutput {
	const stdout = execFileSync("node", [HOOK], {
		cwd: REPO_ROOT,
		input: JSON.stringify(payload),
		encoding: "utf8",
	})

	return tryParsingJSON<HookOutput>(stdout) ?? {}
}

describe("symbol-precheck hook", () => {
	it("reports the existing home of a symbol being written", () => {
		const output = runHook({
			hook_event_name: "PreToolUse",
			tool_name: "Write",
			cwd: REPO_ROOT,
			tool_input: {
				file_path: `${REPO_ROOT}packages/mailwoman/brand-new-file.ts`,
				content: "export function percentile(xs: number[], p: number) {\n\treturn 0\n}\n",
			},
		})

		expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse")
		expect(output.hookSpecificOutput?.additionalContext).toContain("packages/core/utils/stats.ts")
	})

	it("stays silent when the symbol has no exported home", () => {
		const output = runHook({
			hook_event_name: "PreToolUse",
			tool_name: "Write",
			cwd: REPO_ROOT,
			tool_input: {
				file_path: `${REPO_ROOT}scripts/brand-new-script.ts`,
				content: "function main() {\n\treturn 0\n}\n",
			},
		})

		expect(output.hookSpecificOutput).toBeUndefined()
	})

	it("stays silent for a tool that writes no source", () => {
		const output = runHook({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			cwd: REPO_ROOT,
			tool_input: { command: "ls" },
		})

		expect(output.hookSpecificOutput).toBeUndefined()
	})

	it("exits cleanly on a payload it cannot read", () => {
		// Exit 0 with no output. A non-zero exit here would surface as a hook error on an ordinary edit.
		expect(() => runHook({ tool_name: "Write", tool_input: {} })).not.toThrow()
	})
})
