/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared core of the reply prose gate: run a finished agent reply through the Mailwoman Vale
 *   rules and render one verdict. The platform adapters — `vale-response-check.ts` (Claude Code)
 *   and `vale-response-check-codex.ts` (Codex) — own payload parsing, the loop guard, and the
 *   output JSON; the POLICY (which config, which severities block, how findings read) lives here
 *   so the two hooks cannot drift apart the way parallel copies do.
 *
 *   The rule set is `docs/.vale-chat.ini`: the shared Mailwoman style plus the MailwomanChat
 *   additions, fixture-tested by `docs/scripts/check-vale-rules.ts`. The config path resolves
 *   relative to THIS module, so a worktree checkout lints with its own rules.
 *
 *   Severity picks the mechanism. Error-severity findings render a `block` verdict — that tier is
 *   curated to near-zero legitimate use, and the correction must REPLACE the judgment with the
 *   concrete claim, not merely delete the flagged word. Warning-only findings render a `context`
 *   verdict: those rules (opaque IDs, minted metaphors, vague praise) need judgment a regex does
 *   not have, so the agent weighs them.
 */

import { createRequire } from "@mailwoman/core/module/resolvers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { spawnProcessSync } from "@mailwoman/core/process"
import { repoRootPath } from "@mailwoman/core/utils"

const MAX_MATCHES_PER_RULE = 8

export interface ValeAlert {
	Check: string
	Message: string
	Severity: string
	Match: string
	Line: number
}

export interface ProseVerdict {
	kind: "block" | "context"
	text: string
}

export function lintReply(reply: string): ValeAlert[] {
	const require = createRequire(import.meta.url)
	const valeBin = require.resolve("@vvago/vale/bin/vale")
	const configPath = repoRootPath("docs", ".vale-chat.ini")

	// Vale exits 1 when error-severity alerts exist, so the exit code carries no failure signal —
	// an unparseable stdout is the failure, and that reads as "no findings" per the silence contract.
	const result = spawnProcessSync(valeBin, ["--config", configPath, "--output=JSON", "--ext=.md"], {
		input: reply,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 16 * 1024 * 1024,
	})

	const report = tryParsingJSON<Record<string, ValeAlert[]>>(result.stdout)

	if (!report) return []

	return Object.values(report)
		.flat()
		.toSorted((a, b) => {
			if (a.Severity !== b.Severity) return a.Severity === "error" ? -1 : 1

			return a.Line - b.Line
		})
}

/**
 * The rule's guidance with the match's own name factored out, so one grouped line carries the message once instead of
 * once per hit. Message templates vary ("'%s' is …", "Cut the stock form '%s' — …", and templates with no substitution
 * at all), so the fallbacks keep every shape readable.
 */
function ruleGuidance(alert: ValeAlert): string {
	const quoted = `'${alert.Match}'`

	if (alert.Message.startsWith(`${quoted} is `)) return alert.Message.slice(quoted.length + 4)

	if (alert.Message.startsWith(`${quoted} `)) return alert.Message.slice(quoted.length + 1)

	if (alert.Message.includes(quoted)) return alert.Message.replace(quoted, "'…'")

	return alert.Message
}

function formatAlerts(alerts: ValeAlert[], opening: string): string {
	// One line per RULE: the matches with their reply line numbers, then the guidance once. The
	// alerts arrive errors-first, so insertion order keeps error groups above advisory ones.
	const hasErrors = alerts.some((alert) => alert.Severity === "error")
	const groups = new Map<string, { guidance: string; severity: string; hits: { match: string; line: number }[] }>()

	for (const alert of alerts) {
		const group = groups.get(alert.Check) ?? { guidance: ruleGuidance(alert), severity: alert.Severity, hits: [] }

		group.hits.push({ match: alert.Match, line: alert.Line })
		groups.set(alert.Check, group)
	}

	const lines: string[] = []
	let advisoryHeaderWritten = false

	for (const group of groups.values()) {
		if (group.severity !== "error" && !advisoryHeaderWritten && hasErrors) {
			lines.push(`Advisory — weigh each, revise where the finding is right:`)
			advisoryHeaderWritten = true
		}

		const byMatch = new Map<string, number[]>()

		for (const hit of group.hits) {
			const entry = byMatch.get(hit.match) ?? []

			entry.push(hit.line)
			byMatch.set(hit.match, entry)
		}

		const shown = [...byMatch.entries()].slice(0, MAX_MATCHES_PER_RULE)
		const matches = shown.map(([match, hitLines]) => `"${match}" (${hitLines.join(", ")})`).join(", ")
		const overflow = byMatch.size - shown.length
		const tail = overflow > 0 ? `, …and ${overflow} more of the same` : ""

		lines.push(`- ${matches}${tail}: ${group.guidance}`)
	}

	// The rewrite guidance rides only the blocking path — an advisory verdict arrives after the
	// reply stands, where the per-group lines alone are the useful part.
	const guidance = hasErrors
		? [
				`Return only replacement text for the flagged sentences. Do not repeat, summarize, reorder, expand, or otherwise restate any unflagged part of the reply. Replace each flagged phrase with the concrete claim it hides — do not merely delete it. Structure: define project terms at first use; give every count its comparison arm and denominator; state the arithmetic behind derived figures; write addresses in full. A hit inside a verbatim address, place name, or quoted string can stand.`,
			]
		: []

	return [opening, ...guidance, ``, ...lines].join("\n")
}

/**
 * The single decision both platform adapters wrap in their own output JSON. Null when the reply is clean.
 */
export function renderVerdict(alerts: ValeAlert[]): ProseVerdict | null {
	if (!alerts.length) return null

	const errorCount = alerts.filter((alert) => alert.Severity === "error").length

	if (errorCount) {
		return {
			kind: "block",
			text: formatAlerts(
				alerts,
				`Prose check: ${alerts.length} finding${alerts.length === 1 ? "" : "s"} (${errorCount} error). Rewrite only the flagged sentences in plain words per the output style.`
			),
		}
	}

	return {
		kind: "context",
		text: formatAlerts(
			alerts,
			`Prose check: ${alerts.length} advisory finding${alerts.length === 1 ? "" : "s"} in the reply you just wrote.`
		),
	}
}
