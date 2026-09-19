#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SessionStart hook: the reply prose rules, at the top of every session.
 *
 *   why AT session start. Vale's Stop hook is a rejection, and a rejection is the most expensive way to learn a rule:
 *   the reply is already written. The output style names four of the rules, and the other twenty-six arrive only as
 *   findings. This puts the set in front of the work.
 *
 *   what A compaction does TO IT. `SessionStart` fires with `source: "compact"` after the context is compacted, and
 *   this hook declares no matcher, so it runs on `startup`, `resume`, `clear`, `compact` and `fork` alike. The digest
 *   is re-derived and re-injected each time, which is what a claude.md line or a one-time message cannot do.
 *
 *   It fails silent and exits 0 on every error path, for the reason `session-orientation.ts` gives: a session that
 *   cannot start because its orientation hook threw is the worse trade.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { valeRuleDigest } from "#hooks/vale/rule-digest"

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
