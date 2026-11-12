// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The SPDX header every first-party source file starts with, and the rewrite from the old JSDoc header.
 *
 * A file starts with an optional shebang, then the two SPDX lines in the file's comment syntax, then one blank line.
 * Oxfmt's import sorter attaches a comment that touches the first import to that import.
 * Without the blank line, a reordering of the imports moves the header away from the top of the file.
 *
 * The `mailwoman/spdx-header` oxlint rule, the `spdx-header` repository check and the sweep tool all call
 * {@linkcode rewriteSourceHeader}, so each of them agrees on what a correct file is.
 */

/**
 * The copyright holders a header names.
 *
 * Contributors keep the copyright in their own contributions, because `CONTRIBUTING.md` asks for a license grant.
 */
export const SPDX_FILE_COPYRIGHT_TEXT = "Teffen Ellis and Mailwoman contributors"

/**
 * The license expression every `package.json`, `Cargo.toml` and `LICENSE.md` declares.
 */
export const SPDX_LICENSE_EXPRESSION = "AGPL-3.0-only OR LicenseRef-Commercial"

/**
 * The comment syntax a header is written in.
 */
export const SourceHeaderSyntax = {
	/**
	 * `//` line comments: JavaScript, TypeScript, Rust, Java and C++.
	 */
	Slash: "slash",
	/**
	 * `#` line comments: shell.
	 */
	Hash: "hash",
	/**
	 * One `/* … *\/` comment per line: CSS.
	 */
	CSS: "css",
} as const

/**
 * A comment syntax from {@linkcode SourceHeaderSyntax}.
 */
export type SourceHeaderSyntax = (typeof SourceHeaderSyntax)[keyof typeof SourceHeaderSyntax]

const SYNTAX_BY_EXTENSION: ReadonlyMap<string, SourceHeaderSyntax> = new Map([
	["ts", SourceHeaderSyntax.Slash],
	["tsx", SourceHeaderSyntax.Slash],
	["mts", SourceHeaderSyntax.Slash],
	["cts", SourceHeaderSyntax.Slash],
	["js", SourceHeaderSyntax.Slash],
	["mjs", SourceHeaderSyntax.Slash],
	["cjs", SourceHeaderSyntax.Slash],
	["rs", SourceHeaderSyntax.Slash],
	["java", SourceHeaderSyntax.Slash],
	["cpp", SourceHeaderSyntax.Slash],
	["sh", SourceHeaderSyntax.Hash],
	["css", SourceHeaderSyntax.CSS],
])

/**
 * Repository paths whose content is generated or vendored, or whose exact lines a test reads.
 *
 * A directory entry ends with `/`.
 */
export const SPDX_HEADER_EXEMPT_PATHS: readonly string[] = [
	// Yarn's own release bundle.
	".yarn/",
	// The Vale fixtures assert alerts by line.
	"config/vale/fixtures/",
	// Emscripten writes this loader; `build.sh` regenerates it.
	"packages/sentencepiece-wasm/sentencepiece.mjs",
]

/**
 * The header syntax for a repository-relative path, or null when the path takes no header.
 */
export function sourceHeaderSyntax(path: string): SourceHeaderSyntax | null {
	if (SPDX_HEADER_EXEMPT_PATHS.some((exempt) => (exempt.endsWith("/") ? path.startsWith(exempt) : path === exempt))) {
		return null
	}

	if (path.endsWith(".d.ts")) return SourceHeaderSyntax.Slash

	const extension = /\.([a-z]+)$/.exec(path)?.[1]

	return extension == null ? null : (SYNTAX_BY_EXTENSION.get(extension) ?? null)
}

const SCRIPT_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/**
 * Whether a path is JavaScript or TypeScript.
 *
 * The header rewrite for such a path needs the parser's comment ranges.
 */
export function isScriptSourcePath(path: string): boolean {
	return SCRIPT_EXTENSIONS.test(path)
}

/**
 * The two SPDX lines for a syntax, without line endings.
 */
export function spdxHeaderLines(syntax: SourceHeaderSyntax): readonly [string, string] {
	const tags = [
		`SPDX-FileCopyrightText: ${SPDX_FILE_COPYRIGHT_TEXT}`,
		`SPDX-License-Identifier: ${SPDX_LICENSE_EXPRESSION}`,
	]

	switch (syntax) {
		case SourceHeaderSyntax.Slash:
			return [`// ${tags[0]}`, `// ${tags[1]}`]
		case SourceHeaderSyntax.Hash:
			return [`# ${tags[0]}`, `# ${tags[1]}`]
		case SourceHeaderSyntax.CSS:
			return [`/* ${tags[0]} */`, `/* ${tags[1]} */`]
	}
}

/**
 * The header text a generator writes before a module's own content: both SPDX lines and the blank line.
 */
export function spdxHeaderText(syntax: SourceHeaderSyntax): string {
	return `${spdxHeaderLines(syntax).join("\n")}\n\n`
}

/**
 * Matches the first line of an old header, in any of its comment forms.
 *
 * The match is anchored to the line, so the rewrite keeps prose that mentions the old header mid-sentence.
 */
const OLD_HEADER_COPYRIGHT_LINE = /^[\t ]*(?:\*|\/\/|#)[\t ]*@copyright Sister Software\b/

/**
 * Matches a tag line of an old header inside its comment.
 */
const OLD_HEADER_TAG_LINE = /^[\t ]*(?:\*|\/\/|#)[\t ]*@(?:copyright|license|author)\b/

const EMPTY_STAR_LINE = /^[\t ]*\*[\t ]*\r?$/
const EMPTY_LINE_COMMENT = /^[\t ]*(?:\/\/|#)[\t ]*\r?$/
const BLANK_LINE = /^[\t ]*\r?$/

/**
 * The start and end offsets of one comment, as a parser reports it.
 */
export type CommentRange = readonly [start: number, end: number]

/**
 * Removes the old header's tag lines from every comment holding them, in place.
 *
 * With `comments`, a tag line counts only when it lies inside one of those ranges.
 * A generator's template literal can spell the old header as text, and that check keeps it unchanged.
 *
 * Without `comments`, a tag line counts when the lines around it form a comment.
 * Comments are processed from the bottom up, so the offsets of the earlier ones stay valid.
 */
function removeOldHeaders(lines: string[], comments: readonly CommentRange[] | undefined): void {
	const lineStarts: number[] = []
	let offset = 0

	for (const line of lines) {
		lineStarts.push(offset)
		offset += line.length + 1
	}

	const isComment = (index: number): boolean => {
		if (comments == null) return insideComment(lines, index)

		const at = lineStarts[index]! + /^[\t ]*/.exec(lines[index]!)![0].length

		return comments.some(([start, end]) => start <= at && at < end)
	}

	const candidates = lines.flatMap((line, index) =>
		OLD_HEADER_COPYRIGHT_LINE.test(line) && isComment(index) ? [index] : []
	)

	for (const tagLine of candidates.toReversed()) {
		removeOldHeaderAt(lines, tagLine)
	}
}

function removeOldHeaderAt(lines: string[], tagLine: number): void {
	if (/^[\t ]*\*/.test(lines[tagLine]!)) {
		const opener = findOpener(lines, tagLine)
		const closer = lines.findIndex((line, index) => index >= tagLine && line.includes("*/"))

		if (opener === -1 || closer === -1 || opener === closer) return

		const body = lines.slice(opener + 1, closer).filter((line) => !OLD_HEADER_TAG_LINE.test(line))

		while (body.length && EMPTY_STAR_LINE.test(body[0]!)) {
			body.shift()
		}

		if (
			!body.length &&
			/^[\t ]*\/\*\*?[\t ]*\r?$/.test(lines[opener]!) &&
			/^[\t ]*\*\/[\t ]*\r?$/.test(lines[closer]!)
		) {
			let end = closer + 1

			while (end < lines.length && BLANK_LINE.test(lines[end]!) && end < lines.length - 1) {
				end++
			}

			lines.splice(opener, end - opener)
		} else {
			lines.splice(opener + 1, closer - opener - 1, ...body)
		}

		return
	}

	const marker = /^[\t ]*(\/\/|#)/.exec(lines[tagLine]!)![1]!
	const isRunLine = (line: string) => line.trimStart().startsWith(marker) && !line.startsWith("#!")
	let start = tagLine
	let end = tagLine

	while (start > 0 && isRunLine(lines[start - 1]!)) {
		start--
	}

	while (end + 1 < lines.length && isRunLine(lines[end + 1]!)) {
		end++
	}

	const run = lines.slice(start, end + 1).filter((line) => !OLD_HEADER_TAG_LINE.test(line))

	while (run.length && EMPTY_LINE_COMMENT.test(run[0]!)) {
		run.shift()
	}

	lines.splice(start, end - start + 1, ...run)
}

function findOpener(lines: readonly string[], from: number): number {
	for (let index = from; index >= 0; index--) {
		const line = lines[index]!

		if (index < from && line.includes("*/")) return -1

		if (line.includes("/*")) return index
	}

	return -1
}

function insideComment(lines: readonly string[], index: number): boolean {
	const line = lines[index]!

	if (/^[\t ]*(?:\/\/|#)/.test(line)) return true

	return findOpener(lines, index) >= 0
}

/**
 * Returns `text` with the SPDX header as its first lines and the old JSDoc header's tags removed.
 *
 * The rest of the old header's comment stays where it was.
 * A comment left empty is deleted.
 *
 * A file that already starts correctly comes back unchanged, so the rewrite is idempotent.
 *
 * A JavaScript or TypeScript caller passes `comments`, the parser's comment ranges.
 * A template literal can spell the old header, and only the parser tells it from a comment.
 */
export function rewriteSourceHeader(
	text: string,
	syntax: SourceHeaderSyntax,
	comments?: readonly CommentRange[]
): string {
	const header = spdxHeaderLines(syntax)
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one source file, already in memory, edited by line index
	const lines = text.split("\n")

	removeOldHeaders(lines, comments)

	const shebang = lines[0]?.startsWith("#!") ? lines.shift()! : null
	// A misplaced copy of the SPDX lines moves to the top rather than being written twice.
	const rest = lines.filter((line) => line.replace(/\r$/, "") !== header[0] && line.replace(/\r$/, "") !== header[1])

	while (rest.length > 1 && BLANK_LINE.test(rest[0]!)) {
		rest.shift()
	}

	const endsWithNewline = text.endsWith("\n")
	const body = rest.length === 1 && rest[0] === "" ? [] : rest
	const composed = [...(shebang == null ? [] : [shebang]), ...header, ...(body.length ? ["", ...body] : [])].join("\n")

	return endsWithNewline && !composed.endsWith("\n") ? `${composed}\n` : composed
}

/**
 * Describes what's wrong with a file's header, or returns null when the file starts correctly.
 */
export function sourceHeaderProblem(
	text: string,
	syntax: SourceHeaderSyntax,
	comments?: readonly CommentRange[]
): string | null {
	if (rewriteSourceHeader(text, syntax, comments) === text) return null

	const [copyright, license] = spdxHeaderLines(syntax)

	return (
		`The file must start with \`${copyright}\` and \`${license}\`, after any shebang, followed by one blank line. ` +
		"The old `@copyright`/`@license`/`@author` JSDoc tags go. The autofix writes the header."
	)
}
