#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Claude Code Stop hook: run the assistant's finished reply through the Mailwoman Vale rules and
 *   hand the findings back, so the agent revises the reply instead of letting the jargon stand.
 *   The lint policy — rule set, severity split, finding format — lives in `vale-check-core.ts`,
 *   shared with the Codex adapter; this file owns only the Claude payload shape, the loop guard,
 *   and the output JSON.
 *
 *   Error-severity findings return `decision: "block"`, which sends the reason back for one
 *   corrective turn; warning-only findings return the non-blocking `systemMessage` for the agent to weigh. The
 *   `stop_hook_active` guard caps the loop at one revision pass per stop: the revised reply is not
 *   re-linted, so a false positive costs one turn at most. Every failure path is silence, same
 *   contract as `symbol-precheck.ts` — a hook that throws on an unanticipated payload is a broken
 *   session rather than a missing hint.
 *
 *   Register it in `.claude/settings.json` under `hooks.Stop`.
 */

import { readLocalTextFile, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { TextSpliterator } from "spliterator"

import { lintReply, renderVerdict } from "#hooks/vale-check-core"

/**
 * The reply text, preferring the payload's `last_assistant_message` and falling back to the transcript. The fallback
 * exists because a silently absent field would read as "the reply was clean" — a false negative indistinguishable from
 * a real absence.
 */
async function readReply(payload: Record<string, unknown> | null): Promise<string> {
	const direct = payload?.last_assistant_message

	if (typeof direct === "string" && direct.trim()) return direct

	const transcriptPath = payload?.transcript_path

	if (typeof transcriptPath !== "string") return ""

	// The wanted entry is the LAST assistant line; the substring pre-filter keeps only candidate
	// lines resident while the transcript streams forward.
	const candidates = TextSpliterator.from(await readLocalTextFile(transcriptPath))
		.filter((line) => line.includes('"assistant"'))
		.toArray()

	for (let i = candidates.length - 1; i >= 0; i--) {
		const entry = tryParsingJSON<{ type?: string; message?: { content?: unknown } }>(candidates[i])

		if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue

		const text = entry.message.content
			.filter((block): block is { type: string; text: string } => {
				return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
			})
			.map((block) => block.text)
			.join("\n\n")

		if (text.trim()) return text
	}

	return ""
}

async function main(): Promise<void> {
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	// One revision pass per stop: when the turn is already continuing because of a Stop hook, the
	// revised reply passes unchecked rather than looping.
	if (payload?.stop_hook_active === true) return

	const reply = await readReply(payload)

	if (!reply) return

	const verdict = renderVerdict(lintReply(reply))

	if (!verdict) return

	if (verdict.kind === "block") {
		process.stdout.write(JSON.stringify({ decision: "block", reason: verdict.text }))

		return
	}

	process.stdout.write(JSON.stringify({ systemMessage: verdict.text }))
}

try {
	await main()
} catch {
	// Silence is the contract. See the header.
}
