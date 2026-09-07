/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { type HookOutput, runHook as driveHook } from "../hook-harness.ts"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "symbol-precheck.ts")
const REPO_ROOT = repoRootPath()

function runHook(payload: unknown): HookOutput {
	return driveHook(HOOK, payload)
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
		expect(output.hookSpecificOutput?.additionalContext).toContain("packages/core/lib/stats.ts")
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
