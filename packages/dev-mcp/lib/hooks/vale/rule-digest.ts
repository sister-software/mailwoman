/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The reply prose rules, as one listing, derived from the rule files rather than restated beside them.
 *
 *   why derive IT. The Stop hook (`vale/response/check/index.ts`) checks every finished reply against
 *   `config/vale/.vale-chat.ini`, and until the check fires a session knows only the four rules the output style
 *   names. Twenty-odd others are invisible until one of them blocks a reply, so the first the agent hears of a rule is
 *   a rejection. Restating the set in prose would fix that once and then drift, because the rule files change and a
 *   second copy does not. This reads the files.
 *
 *   what IT withholds. `WITHHELD_TOKENS` names the rules whose word lists must not reach a session through its
 *   instructions: naming the words is how they enter a reply. That discipline is agents.md's ("This file does not list
 *   them, so that the words never enter an agent's context through the instructions") and the output style's. For
 *   those rules the digest carries the message and the rewrite it asks for, which is what a writer needs, and points
 *   at the file for the list, which is what a finding needs. Every other rule's `swap` map is mechanical and is
 *   included: a spelling a writer never sees cannot be avoided.
 *
 *   The parse is a line scan rather than a YAML load. The three fields wanted are flat scalars and one flat map, the
 *   tree ships no YAML parser, and `packages/mailwoman/lib/coverage/census.ts` reads its own flat block the same way
 *   for a reason a parser would break.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Rules whose token list stays out of the digest. Each of these bans a word, so printing the
 * word to open a session plants it. A finding names the rule, and the rule file holds the list.
 */
const WITHHELD_TOKENS = new Set([
	"AmbiguousShorthand",
	"AmbiguousShorthandCode",
	"ProjectShorthand",
	"ShellNoun",
	"EmphasisCapitals",
])

/**
 * Rules that exist for a surface other than a reply. `.vale-chat.ini` loads the whole
 * style directory, so a source-comment variant is loaded and reports the same site twice.
 * The digest names the reply-facing one only.
 */
const CODE_SURFACE_ONLY = new Set(["AmbiguousShorthandCode", "CommentSemicolons"])

export interface ValeRule {
	name: string
	level: "error" | "warning" | "suggestion"
	message: string
	/**
	 * A `substitution` rule states what to write in its swap map.
	 * An `existence` rule states it in a token list.
	 */
	extends: string
	swap: Array<[string, string]>
}

/**
 * `message: "…"` / `level: error` / `extends: existence`, each a flat scalar at column zero.
 */
function scalarField(source: string, field: string): string {
	const value = new RegExp(`^${field}:\\s*(.+)$`, "mu").exec(source)?.[1]

	if (!value) return ""

	return value.trim().replace(/^["'](.*)["']$/su, "$1")
}

/**
 * The `swap:` block's `from: to` pairs, which are indented under it and end at the next column-zero key.
 */
function swapPairs(source: string): Array<[string, string]> {
	const block = /^swap:\n((?:[ \t]+.*\n?)*)/mu.exec(source)?.[1]

	if (!block) return []

	const pairs: Array<[string, string]> = []

	for (const line of TextSpliterator.from(block)) {
		// A key may be quoted and may itself contain `:` — `'(?:^|[^-\w])text search': forward geocoding`.
		// Match the quoted form first so the split lands on the separator
		// rather than on a colon inside the pattern.
		const entry = /^\s+(?:'([^']*)'|"([^"]*)"|([^:]+)):\s*(.+?)\s*$/u.exec(line)
		const key = entry?.[1] ?? entry?.[2] ?? entry?.[3]
		const value = entry?.[4]

		if (!key || !value) continue

		pairs.push([key.trim(), value.replace(/^["'](.*)["']$/su, "$1")])
	}

	return pairs
}

/**
 * The rules `.vale-chat.ini` leaves on. `BasedOnStyles = styles` turns the whole directory on,
 * so the config's job here is the `styles.X = no` lines that turn one back off.
 */
function disabledRules(config: string): Set<string> {
	const off = new Set<string>()

	for (const [, rule] of config.matchAll(/^styles\.([\w.]+)\s*=\s*NO\s*$/gmu)) {
		if (rule) {
			off.add(rule)
		}
	}

	return off
}

/**
 * Every rule file under the style directory, repo-relative, including the
 * `Grammar/` subdirectory that Vale addresses as `styles.Grammar.<name>`.
 * Read from git rather than from the directory, because `@mailwoman/core/fs` owns every
 * `node:fs` call in the tree and exposes no listing; `trackedFiles` is the enumerator
 * the repo already uses. An untracked rule file is therefore absent from the digest,
 * which is correct — the rule set is committed.
 */
function ruleFiles(repoRoot: string): Promise<string[]> {
	// One `*` and not `**`: git's pathspec wildcard crosses `/`, so this reaches `Grammar/` too,
	// where `**/*.yml` would require a subdirectory and return the three nested rules alone.
	return trackedFiles(repoRoot, ["config/vale/styles/*.yml"])
}

/**
 * Vale's name for a rule file: `Grammar/SloganAssertions.yml` is `Grammar.SloganAssertions`.
 */
function ruleName(path: string): string {
	return path
		.replace(/^config\/vale\/styles\//u, "")
		.replace(/\.yml$/u, "")
		.replaceAll("/", ".")
}

export async function readChatRules(repoRoot = String(repoRootPath())): Promise<ValeRule[]> {
	const config = await readLocalTextFile(join(repoRoot, "config", "vale", ".vale-chat.ini"))
	const off = disabledRules(config)
	const rules: ValeRule[] = []

	for (const relativePath of await ruleFiles(repoRoot)) {
		const name = ruleName(relativePath)

		if (off.has(name) || CODE_SURFACE_ONLY.has(name)) continue

		const source = await readLocalTextFile(join(repoRoot, relativePath))
		const message = scalarField(source, "message")

		if (!message) continue

		const level = scalarField(source, "level")

		rules.push({
			name,
			level: level === "warning" || level === "suggestion" ? level : "error",
			message,
			extends: scalarField(source, "extends"),
			swap: WITHHELD_TOKENS.has(name) ? [] : swapPairs(source),
		})
	}

	return rules
}

/**
 * A message is written around Vale's `%s`, and its grammar depends on the placeholder staying
 * in position — "Remove the stock form %s" and "%s is filler" need different subjects.
 * Rendering it as `<match>` keeps every sentence correct without rewriting any of them.
 */
function asRule(message: string): string {
	return message.replaceAll("'%s'", "`<match>`").replaceAll("%s", "`<match>`")
}

export function renderRuleDigest(rules: ValeRule[]): string {
	if (!rules.length) return ""

	const blocking = rules.filter((rule) => rule.level === "error")
	const advisory = rules.filter((rule) => rule.level !== "error")

	const section = (heading: string, set: ValeRule[]) =>
		!set.length
			? []
			: [
					"",
					heading,
					...set.map((rule) => {
						// A substitution rule is defined by its swap map, and its message is two
						// placeholders around "instead of", which says nothing once they are gone.
						// Print the pairs in its place.
						if (rule.extends === "substitution" && rule.swap.length) {
							return `- ${rule.name}: ${rule.swap.map(([from, to]) => `${from} → ${to}`).join(", ")}.`
						}

						return `- ${rule.name}: ${asRule(rule.message)}`
					}),
				]

	return [
		`The ${rules.length} Vale rules the Stop hook checks every finished reply against ` +
			"(`config/vale/.vale-chat.ini`). This is the rule set, derived from the rule files at session start, so it " +
			"survives a compaction and cannot drift from what the check enforces.",
		"",
		"Inline code and fenced blocks are exempt in markdown, so a backticked identifier, path or command passes — " +
			"which is how one should be written anyway. YAML frontmatter is NOT exempt, and neither is a source comment.",
		"",
		"Four rules deliberately keep their word lists out of this listing, because naming a banned word plants it: " +
			`${[...WITHHELD_TOKENS].filter((name) => !CODE_SURFACE_ONLY.has(name)).join(", ")}. ` +
			"When a finding names one, read `config/vale/styles/<Rule>.yml` for its list and its remedy.",
		...section("Error level — these block a reply:", blocking),
		...section("Warning level — these need judgment:", advisory),
	].join("\n")
}

export async function valeRuleDigest(repoRoot?: string): Promise<string> {
	return renderRuleDigest(await readChatRules(repoRoot))
}
