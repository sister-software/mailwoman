#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PreToolUse hook: refuse a Bash command that `bash-write-rules.ts` does not admit, so an edit to a tracked file goes
 *   through the Write and Edit tools and reaches the symbol precheck.
 *
 *   This file is the ADAPTER — the payload, the repository root, and the refusal document. Which commands are admitted
 *   and why lives in the rules module, so a test drives the judgement without spawning a process. Importing a hook that
 *   reads stdin at load hangs whatever imports it, which is what happened when the two lived together.
 *
 *   ON FAILURE THIS ADMITS. An unreadable payload, a missing dependency or a throw all let the command through, and the
 *   session then runs unguarded with one line on stderr. That is deliberate — a hook that halts the shell over its own
 *   bug is worse than one that misses a write — and it is why the rules module describes itself as raising the cost of
 *   a Bash edit rather than preventing one.
 */

import { readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"

import { judgeCommand } from "#hooks/bash-write-rules"

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	if (!payload || payload["tool_name"] !== "Bash") return

	const input = payload["tool_input"]
	const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined

	if (typeof command !== "string" || !command.trim()) return

	// The repository this hook ships in, located from the hook's own file rather than from an environment variable the
	// harness sets: a session started in a subdirectory still guards the same tree.
	const repoRoot = String(repoRootPath()).replace(/\/$/u, "")
	const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : repoRoot
	const refusal = judgeCommand(command, repoRoot, cwd)

	if (!refusal) return

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: `${refusal.reason} ${refusal.guidance}`,
			},
		})
	)
}

try {
	await main()
} catch {
	// See the header: failure admits.
}
