/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Drive a hook exactly as the harness does: one JSON payload on stdin, one JSON document on stdout.
 */

import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"

/**
 * The half of a hook's answer every suite here reads; a hook that makes no
 * statement answers an empty document.
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
 * Run `hookPath` over `payload`; a payload given as a string is sent verbatim,
 * which is how a malformed one is tested.
 */
export function runHook(hookPath: string, payload: unknown): HookOutput {
	const stdout = runFileSync("node", [hookPath], {
		cwd: repoRootPathBuilder(),
		input: typeof payload === "string" ? payload : stringifyJSON(payload),
		encoding: "utf8",
	})

	return tryParsingJSON<HookOutput>(stdout) ?? {}
}
