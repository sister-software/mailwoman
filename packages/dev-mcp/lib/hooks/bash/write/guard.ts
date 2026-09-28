#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PreToolUse hook: refuse a Bash command that `bash-write-rules.ts` does not admit, so an edit to a tracked file goes
 *   through the Write and Edit tools and reaches the symbol precheck.
 *
 *   This file adapts the payload, repository root and refusal document. The rules module decides which commands it admits
 *   and why. A test can drive that judgement without spawning a process. A hook that reads stdin at load hangs every importer.
 *
 *   on failure this admits. An unreadable payload, missing dependency or throw lets the command through.
 *   The session then runs unguarded with one line on stderr. That is deliberate — a hook that halts the shell over its own
 *   bug is worse than one that misses a write. This is why the rules module describes itself as raising the cost of
 *   a Bash edit rather than preventing one.
 */

import { readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"

import { judgeCommand } from "#hooks/bash/write/rules"

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	if (!payload || payload["tool_name"] !== "Bash") return

	const input = payload["tool_input"]
	const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined

	if (typeof command !== "string" || !command.trim()) return

	// The repository this hook ships in, located from the hook's own file rather than from an environment
	// variable the harness sets: a session started in a subdirectory still guards the same tree.
	const repoRoot = repoRootPath().replace(/\/$/u, "")
	const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : repoRoot
	const refusal = judgeCommand(command, repoRoot, cwd)

	if (!refusal) return

	process.stdout.write(
		stringifyJSON({
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
