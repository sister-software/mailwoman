/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Indexes the first docstring sentence of each exported function, so a search can match on behavior.
 *
 *   A name search in `symbol/index.ts` misses a function whose name shares no words with the query. The TypeScript
 *   parser reads each statement's modifiers and leading comment. A declaration without a docstring is not indexed.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitHead, trackedFiles, workingTreeStatus } from "@mailwoman/core/git"
import type { PathBuilder } from "path-ts"
import ts from "typescript"

/**
 * One exported function and the first sentence of its docstring.
 */
export interface PurposeEntry {
	name: string
	/**
	 * The repository-relative file path.
	 */
	file: string
	line: number
	/**
	 * The docstring's first sentence, without tags or comment markers.
	 */
	sentence: string
}

/**
 * Returns the exported function name that a top-level statement declares, or `null`.
 *
 * For a variable statement, only the first declaration is read.
 */
function exportedName(statement: ts.Statement): string | null {
	if (!ts.canHaveModifiers(statement)) return null

	const exported = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

	if (!exported) return null

	if (ts.isFunctionDeclaration(statement)) return statement.name?.text ?? null

	if (ts.isVariableStatement(statement)) {
		const [declaration] = statement.declarationList.declarations
		const initializer = declaration?.initializer

		// Only a function value counts.
		// Tables and literals are skipped.
		if (
			declaration &&
			initializer &&
			(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
			ts.isIdentifier(declaration.name)
		) {
			return declaration.name.text
		}
	}

	return null
}

/**
 * Words too common to identify a declaration.
 *
 * Prepositions belong here too.
 * One name match is enough to report a finding, so a query word such as `over`
 * would otherwise match `bestOver`.
 */
const STOP_WORDS = new Set([
	"a",
	"after",
	"all",
	"also",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"before",
	"between",
	"both",
	"by",
	"can",
	"each",
	"every",
	"for",
	"from",
	"given",
	"in",
	"into",
	"is",
	"it",
	"its",
	"not",
	"of",
	"off",
	"on",
	"one",
	"only",
	"or",
	"other",
	"out",
	"over",
	"per",
	"same",
	"some",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"this",
	"to",
	"two",
	"under",
	"up",
	"via",
	"was",
	"what",
	"when",
	"which",
	"with",
])

/**
 * Returns the first sentence of a docstring body, without comment markers or tag lines.
 */
export function firstSentence(doc: string): string {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one docstring, already resident and bounded by it.
	const prose = doc
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/u, "").trim())
		.filter((line) => !line.startsWith("@"))
		.join(" ")
		.replaceAll(/\s+/gu, " ")
		.trim()

	const end = prose.search(/\.(?:\s|$)/u)

	return (end === -1 ? prose : prose.slice(0, end + 1)).trim()
}

/**
 * Splits a phrase into lowercase match terms, separating camelCase
 * and dropping stop words and single characters.
 */
function terms(phrase: string): string[] {
	return phrase
		.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
}

/**
 * Reads every documented exported function under a workspace `lib/` directory in the working tree.
 */
async function readEntries(repoRoot: PathBuilder): Promise<PurposeEntry[]> {
	// The file filter runs here because a `lib/**` pathspec would skip files directly inside `lib/`.
	const files = await trackedFiles(repoRoot, ["packages"])
	const entries: PurposeEntry[] = []

	for (const file of files) {
		if (!file.includes("/lib/") || !file.endsWith(".ts") || file.endsWith(".test.ts")) continue

		const text = await readLocalTextFile(repoRoot(file))
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

		for (const statement of source.statements) {
			const name = exportedName(statement)

			if (!name) continue

			// The last leading JSDoc block belongs to the declaration.
			const doc = (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [])
				.map((range) => text.slice(range.pos, range.end))
				.findLast((comment) => comment.startsWith("/**"))

			const sentence = doc ? firstSentence(doc.replace(/^\/\*\*/u, "").replace(/\*\/$/u, "")) : ""

			if (!sentence) continue

			entries.push({
				name,
				file,
				line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
				sentence,
			})
		}
	}

	return entries
}

interface PurposeCache {
	/**
	 * The commit the index was built from.
	 *
	 * Together with `status`, which lists staged, unstaged and untracked changes,
	 * it keys the cache so uncommitted edits and new files invalidate it.
	 */
	head: string
	status: string[]
	entries: PurposeEntry[]
}

function cachePath(): string {
	return cacheRootPath("dev-mcp", "symbol-purpose.json")
}

/**
 * Returns the purpose index, from cache when the working tree has not changed since the cache was built.
 */
export async function loadPurposeIndex(repoRoot: PathBuilder): Promise<PurposeEntry[]> {
	const head = await gitHead(repoRoot)
	const status = (await workingTreeStatus(repoRoot, ["packages"])).toSorted()
	const cached = await readLocalJSONFile<Partial<PurposeCache>>(cachePath()).catch(() => null)

	// The fields are checked, so a cache in an older format triggers a rebuild instead of a throw.
	if (
		cached?.head === head &&
		Array.isArray(cached.status) &&
		Array.isArray(cached.entries) &&
		cached.status.join("\n") === status.join("\n")
	) {
		return cached.entries
	}

	const entries = await readEntries(repoRoot)

	await writeLocalJSONFile({ head, status, entries } satisfies PurposeCache, cachePath()).catch(() => undefined)

	return entries
}

/**
 * An entry that matches a search phrase, with the terms that matched.
 */
export interface PurposeFinding extends PurposeEntry {
	matched: string[]
}

/**
 * Returns the entries whose name or sentence matches `phrase`, best first.
 *
 * A finding needs two matching terms, or one term in the name.
 * A term in the name scores 2 and a term in the sentence scores 1.
 */
export function searchPurpose(phrase: string, entries: readonly PurposeEntry[], limit = 10): PurposeFinding[] {
	const wanted = new Set(terms(phrase))

	if (!wanted.size) return []

	const scored: Array<{ finding: PurposeFinding; score: number }> = []

	for (const entry of entries) {
		const inName = new Set(terms(entry.name))
		const inSentence = new Set(terms(entry.sentence))
		const matched = [...wanted].filter((word) => inName.has(word) || inSentence.has(word))

		if (matched.length < 2 && !matched.some((word) => inName.has(word))) continue

		// A query word equal to the whole name adds 5, so "percentile of a list of
		// numbers" ranks `percentile` above `splitNumberList`.
		const exact = wanted.has(entry.name.toLowerCase()) ? 5 : 0
		const score = exact + matched.reduce((total, word) => total + (inName.has(word) ? 2 : 1), 0)

		if (!score) continue

		scored.push({ finding: { ...entry, matched }, score })
	}

	return scored
		.toSorted((a, b) => b.score - a.score || a.finding.name.length - b.finding.name.length)
		.slice(0, limit)
		.map(({ finding }) => finding)
}
