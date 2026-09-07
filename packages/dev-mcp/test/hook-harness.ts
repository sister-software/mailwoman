/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Drive a hook exactly as the harness does: one JSON payload on stdin, one JSON document on stdout. Three hook
 *   suites had typed this prelude separately, which is the shape the symbol precheck exists to catch.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"

/**
 * The half of a hook's answer every suite here reads. A hook that says nothing answers an empty document.
 */
export interface HookOutput {
	hookSpecificOutput?: {
		hookEventName?: string
		additionalContext?: string
		permissionDecision?: string
		permissionDecisionReason?: string
	}
}

/**
 * Run `hookPath` over `payload`. A payload given as a string is sent verbatim, which is how a malformed one is tested.
 */
export function runHook(hookPath: string, payload: unknown): HookOutput {
	const stdout = runFileSync("node", [hookPath], {
		cwd: String(repoRootPath()),
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf8",
	})

	return tryParsingJSON<HookOutput>(stdout) ?? {}
}
