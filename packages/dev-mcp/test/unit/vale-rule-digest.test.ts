/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the SessionStart prose-rule listing.
 *
 *   Two things are worth pinning, and neither is the wording. The first is that the listing is derived: a rule added
 *   to the style directory reaches the listing without anyone editing prose, which is the whole reason it reads the
 *   files. The second is the withholding — a rule that bans a word must not print the word, because the listing is
 *   injected into a session and naming the word is how it enters a reply. That discipline is prose in agents.md and
 *   in the output style, and an assertion is the only form of it that cannot quietly lapse.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { lintReply } from "@mailwoman/dev-mcp/hooks/vale/check-core"
import { readChatRules, renderRuleDigest } from "@mailwoman/dev-mcp/hooks/vale/rule-digest"
import { TextSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

const rules = await readChatRules()
const digest = renderRuleDigest(rules)
const named = new Set(rules.map((rule) => rule.name))

/**
 * A rule file's tokens, compiled.
 *
 * Returned as patterns rather than as words on purpose: writing the words into this test
 * would put them in a tracked file, which is the thing the withholding exists to prevent
 * and which `repo-health`'s `bannedVocabulary` counter holds at zero.
 * Compiling the rule's own token and running it over the listing asks the same question and writes nothing.
 */
async function tokenPatterns(rule: string): Promise<RegExp[]> {
	const source = await readLocalTextFile(repoRootPath("config", "vale", "styles", `${rule}.yml`))
	const block = /^tokens:\n((?:[ \t]+.*\n?)*)/mu.exec(source)?.[1]

	if (!block) return []

	const patterns: RegExp[] = []

	for (const line of TextSpliterator.from(block)) {
		const token = /^\s+-\s+(.+?)\s*$/u.exec(line)?.[1]?.replace(/^["'](.*)["']$/su, "$1")

		if (!token) continue

		try {
			patterns.push(new RegExp(`\\b(?:${token})\\b`, "iu"))
		} catch {
			// A token Vale's engine accepts and JavaScript's does not is skipped rather than failing the test.
		}
	}

	return patterns
}

describe("the session-start prose-rule listing", () => {
	it("carries the rules the output style never names", () => {
		// The gap this closes: the output style names four rules, and these arrived later.
		// A session learned them only when one blocked a reply.
		expect(named).toContain("Negation")
		expect(named).toContain("MedicalMetaphor")
		expect(named).toContain("Grammar.SloganAssertions")
	})

	it("leaves out the rules the chat config turns off", () => {
		expect(named).not.toContain("CommentSemicolons")
	})

	it("leaves out the source-comment variant that duplicates a reply rule", () => {
		// `.vale-chat.ini` loads the whole style directory, so the comment-surface
		// copy is live and reports the same site twice.
		// Listing both would read as two separate rules.
		expect(named).not.toContain("AmbiguousShorthandCode")
		expect(named).toContain("AmbiguousShorthand")
	})

	it("states the remedy for a withheld rule without printing its words", async () => {
		const rule = rules.find((candidate) => candidate.name === "AmbiguousShorthand")

		expect(rule?.swap).toEqual([])
		expect(digest).toContain("name the concrete thing")

		const patterns = await tokenPatterns("AmbiguousShorthand")

		// The check is only worth running if the file has tokens to check, and it is
		// only sound if they are the patterns Vale itself refuses.
		// A compile failure that emptied this list would pass the loop silently.
		expect(patterns.length).toBeGreaterThan(3)

		for (const pattern of patterns) {
			expect(digest).not.toMatch(pattern)
		}
	})

	it("prints a substitution rule as its swap pairs", () => {
		expect(digest).toContain("neighbourhood → neighborhood")
		expect(digest).toContain("postal code → postcode")
	})

	it("reads a swap key that contains a colon as one pair", () => {
		// `Terms` carries `'(?:^|[^-\w])text search': forward geocoding`.
		// Splitting on the first colon would take half the key and the listing would
		// print a broken pattern beside the wrong replacement.
		const terms = rules.find((rule) => rule.name === "Terms")
		const entry = terms?.swap.find(([from]) => from.includes("text search"))

		expect(entry?.[1]).toBe("forward geocoding")
	})

	it("states every rule in the register the rules themselves enforce", async () => {
		// A message is read twice: once in this listing at session start, and once when the rule fires.
		// Both times it is prose on a surface the style governs, so a message that breaks
		// another rule both teaches the wrong form and plants the word.
		// Seven did when this test was written — four used a verb `AmbiguousShorthand` refuses,
		// three were framed as the negation `Negation` refuses.
		// The style directory is outside the prose lint's pathspecs, so this assertion
		// is the only thing that holds the line.
		const offenders: string[] = []

		for (const rule of rules) {
			const prose = rule.message.replaceAll("'%s'", "the flagged text").replaceAll("%s", "the flagged text")

			for (const alert of await lintReply(prose)) {
				if (alert.Severity !== "error") continue

				offenders.push(`${rule.name} trips ${alert.Check} on "${alert.Match}"`)
			}
		}

		expect(offenders).toEqual([])
	})

	it("separates the rules that block a reply from the rules that need judgment", () => {
		expect(digest).toContain("Error level")
		expect(digest).toContain("Warning level")
		expect(rules.filter((rule) => rule.level === "error").length).toBeGreaterThan(0)
		expect(rules.filter((rule) => rule.level === "warning").length).toBeGreaterThan(0)
	})
})
