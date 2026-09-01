#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Codex Stop hook: the Codex twin of `vale-response-check.ts`. The lint policy — rule set,
 *   severity split, finding format — lives in `vale-check-core.ts`; this file owns only the Codex
 *   payload shape, the loop guard, and the output JSON. Codex's hook contract
 *   (https://learn.chatgpt.com/docs/hooks) matches Claude Code's on the parts this hook uses:
 *   `Stop` fires when a turn completes, the payload carries `last_assistant_message`, and the
 *   output is `decision: "block"` + `reason` or the non-blocking `systemMessage`. Codex's
 *   Stop-output schema rejects `hookSpecificOutput` because Stop cannot inject additional context.
 *
 *   Two deliberate differences from the Claude adapter:
 *
 *   - Codex has NO `stop_hook_active` field and no built-in loop prevention, so the one-pass guard
 *     is a session-keyed marker file in the OS temp dir: a block writes the marker, and the next
 *     Stop in that session consumes it and passes unchecked. That approximates Claude's semantics
 *     — the reply after a block goes unlinted whatever produced it — and caps a false positive at
 *     one corrective turn.
 *   - There is no transcript fallback: Codex's `transcript_path` is nullable and its transcript
 *     schema is Codex's own, not the JSONL shape the Claude adapter parses. A missing
 *     `last_assistant_message` here is silence, not a parse attempt.
 *
 *   Register it in `.codex/hooks.json` under `hooks.Stop`; the command path is repo-relative,
 *   matching how `.codex/config.toml` addresses `packages/dev-mcp/lib/cli.ts`.
 */

import { pathExists, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { removePath, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { tempRootPath } from "@mailwoman/core/utils"

import { lintReply, renderVerdict } from "#hooks/vale-check-core"

function markerPath(sessionID: string): string {
	return tempRootPath(`mailwoman-vale-codex-${sessionID.replaceAll(/[^\w-]/g, "")}`)
}

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)
	const sessionID = typeof payload?.session_id === "string" ? payload.session_id : ""
	const marker = sessionID ? markerPath(sessionID) : ""

	// One revision pass per block: the marker written by the previous block is consumed here, so
	// the corrective reply passes unchecked rather than looping.
	if (marker && (await pathExists(marker))) {
		await removePath(marker)

		return
	}

	const reply = payload?.last_assistant_message

	if (typeof reply !== "string" || !reply.trim()) return

	const verdict = renderVerdict(lintReply(reply))

	if (!verdict) return

	if (verdict.kind === "block") {
		if (marker) {
			await writeLocalTextFile("", marker)
		}

		process.stdout.write(JSON.stringify({ decision: "block", reason: verdict.text }))

		return
	}

	process.stdout.write(JSON.stringify({ systemMessage: verdict.text }))
}

try {
	await main()
} catch {
	// Silence is the contract. See the header of vale-response-check.ts.
}
