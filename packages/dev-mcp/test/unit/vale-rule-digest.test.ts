/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The listing withholds a banned rule's words, because it is injected into a session and naming the word is how it enters a reply.
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
 * A rule file's tokens compiled as patterns, not words, so no banned token enters a
 * tracked file (`repo-health`'s `bannedVocabulary` counter holds that at zero).
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
		expect(named).toContain("Negation")
		expect(named).toContain("MedicalMetaphor")
		expect(named).toContain("Grammar.SloganAssertions")
	})

	it("leaves out the rules the chat config turns off", () => {
		expect(named).not.toContain("CommentSemicolons")
	})

	it("leaves out the source-comment variant that duplicates a reply rule", () => {
		// `.vale-chat.ini` loads the whole style directory, so the comment-surface copy is live
		// and listing both would read as two separate rules.
		expect(named).not.toContain("AmbiguousShorthandCode")
		expect(named).toContain("AmbiguousShorthand")
	})

	it("states the remedy for a withheld rule without printing its words", async () => {
		const rule = rules.find((candidate) => candidate.name === "AmbiguousShorthand")

		expect(rule?.swap).toEqual([])
		expect(digest).toContain("name the concrete thing")

		const patterns = await tokenPatterns("AmbiguousShorthand")

		// A compile failure that emptied this list would pass the loop silently, so the length is asserted.
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
		// `Terms` carries `'(?:^|[^-\w])text search': forward geocoding`, so splitting on
		// the first colon would print a broken pattern beside the wrong replacement.
		const terms = rules.find((rule) => rule.name === "Terms")
		const entry = terms?.swap.find(([from]) => from.includes("text search"))

		expect(entry?.[1]).toBe("forward geocoding")
	})

	it("states every rule in the register the rules themselves enforce", async () => {
		// The style directory is outside the prose lint's pathspecs, so this assertion is
		// the only thing that holds a rule message to the rules themselves.
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
