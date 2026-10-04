#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SessionStart hook: the reply prose rules, at the top of every session.
 *
 *   why at session start. Vale's Stop hook rejects a reply after it has been written. The output style names four rules.
 *   The other twenty-six arrive only as
 *   findings. This puts the set in front of the work.
 *
 *   how compaction changes it. `SessionStart` fires with `source: "compact"` after the context is compacted.
 *   this hook declares no matcher, so it runs on `startup`, `resume`, `clear`, `compact` and `fork` alike. The digest
 *   The hook re-derives and injects the digest each time. A `claude.md` line or one-time message cannot do that.
 *
 *   It fails silent and exits 0 on every error path, for the reason `session-orientation.ts` gives: a session that
 *   cannot start because its orientation hook threw is the worse trade.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { valeRuleDigest } from "#dev-mcp/hooks/vale/rule-digest"

async function main(): Promise<void> {
	const additionalContext = await valeRuleDigest()

	if (!additionalContext) return

	process.stdout.write(stringifyJSON({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }))
}

try {
	await main()
} catch {
	// See the header: the rule listing is worth less than a session that starts.
}
