/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds a digest of the Vale rules that the Stop hook applies to replies, read from the rule files.
 *
 *   Reading the files keeps the digest in step with the rules. The parser scans lines because the fields it
 *   needs are flat scalars and one flat map, and the repository ships no YAML parser.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Rules whose word lists the digest omits.
 *
 * Each rule bans words, and printing those words into a session's context makes
 * an agent more likely to use them.
 */
const WITHHELD_TOKENS = new Set([
	"AmbiguousShorthand",
	"AmbiguousShorthandCode",
	"ProjectShorthand",
	"ShellNoun",
	"EmphasisCapitals",
])

/**
 * Rules meant for source comments, which the digest leaves out.
 *
 * `.vale-chat.ini` loads the whole style directory, so these rules also load for replies.
 */
const CODE_SURFACE_ONLY = new Set(["AmbiguousShorthandCode", "CommentSemicolons"])

/**
 * One Vale rule as the digest reads it.
 */
export interface ValeRule {
	name: string
	level: "error" | "warning" | "suggestion"
	message: string
	/**
	 * The Vale rule type, such as `substitution` or `existence`.
	 */
	extends: string
	swap: Array<[string, string]>
}

/**
 * Reads a flat scalar at column zero, such as `level: error`, with surrounding quotes removed.
 */
function scalarField(source: string, field: string): string {
	const value = new RegExp(`^${field}:\\s*(.+)$`, "mu").exec(source)?.[1]

	if (!value) return ""

	return value.trim().replace(/^["'](.*)["']$/su, "$1")
}

/**
 * Reads the indented `from: to` pairs of the `swap:` block.
 */
function swapPairs(source: string): Array<[string, string]> {
	const block = /^swap:\n((?:[ \t]+.*\n?)*)/mu.exec(source)?.[1]

	if (!block) return []

	const pairs: Array<[string, string]> = []

	for (const line of TextSpliterator.from(block)) {
		// A quoted key may contain `:`, so the quoted forms are tried before the bare form.
		const entry = /^\s+(?:'([^']*)'|"([^"]*)"|([^:]+)):\s*(.+?)\s*$/u.exec(line)
		const key = entry?.[1] ?? entry?.[2] ?? entry?.[3]
		const value = entry?.[4]

		if (!key || !value) continue

		pairs.push([key.trim(), value.replace(/^["'](.*)["']$/su, "$1")])
	}

	return pairs
}

/**
 * Returns the rules that `.vale-chat.ini` turns off with `styles.X = NO`.
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
 * Returns every tracked rule file under the style directory, including the `Grammar/` subdirectory.
 *
 * The list comes from git, so an untracked rule file does not appear in the digest.
 */
function ruleFiles(repoRoot: PathBuilderLike): Promise<string[]> {
	// A git pathspec `*` crosses `/`, so this pattern also matches `Grammar/`.
	return trackedFiles(repoRoot, ["config/vale/styles/*.yml"])
}

/**
 * Returns Vale's name for a rule file.
 *
 * For example, `Grammar/SloganAssertions.yml` becomes `Grammar.SloganAssertions`.
 */
function ruleName(path: string): string {
	return path
		.replace(/^config\/vale\/styles\//u, "")
		.replace(/\.yml$/u, "")
		.replaceAll("/", ".")
}

/**
 * Reads the rules that `.vale-chat.ini` enables for replies.
 */
export async function readChatRules(repoRoot: PathBuilderLike = repoRootPath()): Promise<ValeRule[]> {
	const root = PathBuilder.from(repoRoot)
	const config = await readLocalTextFile(root("config", "vale", ".vale-chat.ini"))
	const off = disabledRules(config)
	const rules: ValeRule[] = []

	for (const relativePath of await ruleFiles(repoRoot)) {
		const name = ruleName(relativePath)

		if (off.has(name) || CODE_SURFACE_ONLY.has(name)) continue

		const source = await readLocalTextFile(root(relativePath))
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
 * Replaces Vale's `%s` placeholder with `<match>`, which keeps each message grammatical.
 */
function asRule(message: string): string {
	return message.replaceAll("'%s'", "`<match>`").replaceAll("%s", "`<match>`")
}

/**
 * Renders the rules as a Markdown listing, grouped into error and warning levels.
 */
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
						// A substitution rule's message is only placeholders, so the digest prints its pairs instead.
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

/**
 * Reads the reply rules and renders their digest.
 */
export async function valeRuleDigest(repoRoot?: string): Promise<string> {
	return renderRuleDigest(await readChatRules(repoRoot))
}
