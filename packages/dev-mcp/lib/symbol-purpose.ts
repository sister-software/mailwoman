/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What each exported function SAYS IT DOES, so the question "does something that reads a manifest already exist" can
 *   be asked without guessing the name.
 *
 *   WHY A SECOND INDEX. `symbol-index.ts` matches names, and a name search only helps an author who already guessed the
 *   existing name — the one thing an author about to duplicate does not know. `readPackageJSON` shares no substring
 *   with `loadManifest`, `getPkg` or `readProjectJSON`, so every name-shaped query for it comes back empty and reads as
 *   an absence. This indexes the first sentence of each declaration's docstring instead, which is the sentence the
 *   repository already writes and which describes the behaviour rather than the spelling.
 *
 *   IT PARSES. An earlier draft matched a docstring to the `export` below it with a regular expression, which assumed
 *   an adjacency the language does not require and could not tell an exported declaration from a private one carrying
 *   the same shape. The parse reads the modifiers and the leading comment from the statement itself. What stays
 *   uncovered is stated in the tool's `not_covered`: a declaration with no docstring has nothing to index.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { gitHead, trackedFiles, workingTreeStatus } from "@mailwoman/core/git"
import { resolvePath } from "path-ts"
import ts from "typescript"

/**
 * One exported declaration and the sentence that introduces it.
 */
export interface PurposeEntry {
	name: string
	/**
	 * Repo-relative, so an entry reads the same from any working directory.
	 */
	file: string
	line: number
	/**
	 * The first sentence of the docstring, with the tag block and the comment furniture removed.
	 */
	sentence: string
}

/**
 * The exported name a top-level statement declares, or `null`. A variable statement contributes its first declaration,
 * which is how `export const x = () => …` is written here; a statement declaring several names is not this shape.
 */
function exportedName(statement: ts.Statement): string | null {
	if (!ts.canHaveModifiers(statement)) return null

	const exported = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

	if (!exported) return null

	if (ts.isFunctionDeclaration(statement)) return statement.name?.text ?? null

	if (ts.isVariableStatement(statement)) {
		const [declaration] = statement.declarationList.declarations
		const initializer = declaration?.initializer

		// Only a declaration carrying LOGIC is a reuse question: a table or a literal is a different one.
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
 * Words that appear in nearly every sentence here, so matching one says nothing about which declaration is meant.
 *
 * Prepositions earn their place on this list the hard way: `over` is a word in `bestOver`, and a name match is enough
 * on its own to report a finding, so an unlisted preposition answers an unrelated question with a confident hit.
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
 * The first sentence of a docstring body: comment furniture and tag blocks removed, newlines collapsed, and the text
 * ended at the first sentence boundary. A docstring that opens with a tag (`@file`, `@param`) contributes nothing.
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
 * Split a phrase into the words worth matching: lowercase, camelCase separated, stop words and single characters gone.
 */
function terms(phrase: string): string[] {
	return phrase
		.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
}

/**
 * Every documented export in a workspace's `lib/`, read from the working tree.
 */
async function readEntries(repoRoot: string): Promise<PurposeEntry[]> {
	// The pathspec names a DIRECTORY and the shape is filtered here. A pathspec with a globstar inside it silently drops
	// every file sitting directly in `lib/`, because git's wildmatch requires a separator after one — which is how
	// `packages/core/lib/stats.ts` and `packages/spatial/lib/distance.ts` went missing from the first index.
	const files = await trackedFiles(repoRoot, ["packages"])
	const entries: PurposeEntry[] = []

	for (const file of files) {
		if (!file.includes("/lib/") || !file.endsWith(".ts") || file.endsWith(".test.ts")) continue

		const text = await readLocalTextFile(resolvePath(repoRoot, file))
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

		for (const statement of source.statements) {
			const name = exportedName(statement)

			if (!name) continue

			// The LAST leading block comment is the declaration's own: a file header sits above an import, and a comment
			// explaining the line before belongs to that line.
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
	 * The commit the index was built from, plus every working-tree change at that moment — staged, unstaged and untracked
	 * alike. All of it is needed: keying on the commit alone goes stale over an uncommitted edit, and keying on tracked
	 * changes alone misses a NEW file, which is the case this index most needs to see.
	 */
	head: string
	status: string[]
	entries: PurposeEntry[]
}

function cachePath(): string {
	return cacheRootPath("dev-mcp", "symbol-purpose.json")
}

/**
 * The index, from cache when the working tree has not moved since it was built.
 *
 * A stale index is worse than a slow one here: it answers "nothing like that exists" for a helper written an hour ago,
 * which is the reading this tool exists to prevent.
 */
export async function loadPurposeIndex(repoRoot: string): Promise<PurposeEntry[]> {
	const head = await gitHead(repoRoot)
	const status = (await workingTreeStatus(repoRoot, ["packages"])).toSorted()
	const cached = await readLocalJSONFile<Partial<PurposeCache>>(cachePath()).catch(() => null)

	// A cache written by an earlier shape of this module is a MISS, not a crash: the fields are checked rather than
	// assumed, so a renamed key rebuilds instead of throwing inside a tool call.
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
 * A declaration whose stated purpose matches a phrase, and the words that matched.
 */
export interface PurposeFinding extends PurposeEntry {
	matched: string[]
}

/**
 * The declarations whose name or opening sentence answers `phrase`, best first.
 *
 * Scoring is term overlap, weighted so a word in the NAME counts double: a name is chosen to describe the thing, while
 * a sentence also carries the words around it. A single matching term is not enough — one shared word is what every
 * sentence in a domain has in common — so a finding needs two, or one that appears in the name.
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

		// A query word that IS the whole name outranks any amount of sentence overlap: asking for "percentile of a list
		// of numbers" must answer `percentile` before `splitNumberList`, which shares two of the surrounding words.
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
