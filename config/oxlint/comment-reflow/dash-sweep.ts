#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The dash sweep: comment sentences that join two clauses with a dash, rewritten as two sentences.
 *
 *   Only that use moves: a paired dash around an aside stays, and so does a dash introducing a noun phrase.
 *
 *   Paragraphs are joined before rewriting and emitted as one line each. `mailwoman/comment-reflow` re-breaks them
 *   afterwards, so line layout is deliberately not this script's business: run `yarn fix:oxlint` after a sweep.
 */

/// <reference types="node" />

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import ts from "typescript"

const FINITE =
	/\b(is|are|was|were|be|been|has|have|had|does|do|did|will|would|can|could|should|must|makes?|leaves?|reads?|names?|holds?|keeps?|gives?|takes?|means?|stays?|comes?|goes?|sits?|carries|carry|returns?|fires?|fails?|needs?|wants?|uses?|writes?|reports?|answers?|drops?|adds?|counts?|costs?|buys?|pays?|prefers?|refuses?|never|only|already|still)\b/i

/**
 * Words a clause can open a sentence with, once the dash in front of it is a full stop.
 */
const OPENERS =
	/^(?:the|a|an|it|this|that|they|we|you|there|each|every|nothing|nobody|its|their|those|these|both|neither|either|one|two|three|most|some|any|no|so|see|read|unlike|without|once|when|if|after|before|together|instead|otherwise|measured|present|kept|held|anything|everything|same|what|where|whatever|here)\b/i

/**
 * A verb the sentence can open with, where the clause behind the dash is an
 * instruction rather than a statement.
 */
const IMPERATIVES = /^(?:see|read|revisit|compare|note|use|prefer|check|run|treat|measure|keep|expect)\b/i

/**
 * A clause that cannot open a sentence, but reads correctly once the dash is a comma.
 *
 * `not` is deliberately absent: the `Negation` rule refuses `, not` at error level,
 * and `CommentDashJoint` leaves a dash in front of a noun phrase alone, so the dash stays.
 */
const COMMA_OPENERS =
	/^(?:which|and|but|or|nor|yet|rather|while|whereas|though|although|because|since|including|never|with|for|leaving|making|giving|taking)\b/i

/**
 * Characters of left half a joint needs before its dash becomes a full stop.
 *
 * Below this the left half is a label rather than a clause, and a full stop behind it stands a fragment up.
 */
const LEFT_HALF_FLOOR = 24

/**
 * Words a comma-opening right half needs before the comma is worth taking.
 *
 * Two words behind `which` or `and` is an aside, and the dash is the right mark for one.
 */
const COMMA_CLAUSE_FLOOR = 3

/**
 * Words a right half needs before it can stand as a sentence of its own.
 */
const SENTENCE_CLAUSE_FLOOR = 5

/**
 * Lines a starred block needs before it holds prose: the opener, one line of it, and the closer.
 */
const STARRED_BLOCK_LINES = 3

/**
 * A line that carries its own layout, in `mailwoman/comment-reflow`'s own terms.
 *
 * The rule's test is copied here rather than approximated.
 * A line it treats as structural is one it will never re-wrap, so a paragraph this script joins
 * and that rule declines to break stays joined, as one very long line.
 */
const STRUCTURAL_LINE: readonly RegExp[] = [
	/^\s*https?:\/\/\S+\s*$/i,
	/^(?:\s{4}|\t|\s*[*+-]\s|\s*\d+[.)]\s|\s*[#>|]|\s*\[[^\]]+\]:|\s*(?:---+|===+)\s*$|\s*`{3}|\s*~{3}|\s*@)/,
	/^\s*<(?:[!?]|[^>]*$|.*>\s*$)/,
	/(?: {2}|\\)$/,
	/^\s*type\s+[\w$]+(?:\s*<.*>)?\s*=/,
	/^\s*MARK:/,
	/^\s*(?:const |let |var |function |class |import |export |return |if\s*\(|\/\/|\{(?!@)|\})/,
	/^[^{}[\]`]*\s\|\s|^[\w.$]+\(.*\)[;]?$|^[\w.$]+\s*=\s*\S/,
]

const isStructural = (line: string) => STRUCTURAL_LINE.some((pattern) => pattern.test(line))

const LIST_ITEM = /^(\s{0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z`"(])/

const ABBREVIATION = /(?:^|\s)(?:e\.g\.|i\.e\.|etc\.|vs\.|cf\.|ca\.|approx\.|no\.|fig\.|eq\.|al\.|[A-Z]\.)$/i

const LEAD_TAG = /^(Returns|Throws)\b\s+/

const IDENTIFIER = /[._/]|[a-z][A-Z]/

/**
 * Capitalise a clause that is becoming a sentence, unless its first word names something.
 */
function openClause(clause: string): string {
	const [first = ""] = clause.split(/\s+/)

	if (!/^[a-z]/.test(first)) return clause

	// `foo`, foo.bar, fooBar and foo_bar are names.
	// Capitalising one would name something that does not exist.
	if (/^[`[(]/.test(first) || IDENTIFIER.test(first)) return clause

	return first.charAt(0).toUpperCase() + clause.slice(1)
}

/**
 * Rewrite one sentence whose dash is doing a semicolon's work, or return it as it stands.
 */
export function sweepSentence(sentence: string): string {
	const dashes = sentence.match(/[—–]/g)

	if (!dashes || dashes.length !== 1) return sentence

	const index = sentence.search(/[—–]/)
	const before = sentence.slice(0, index).trimEnd()
	const after = sentence.slice(index + 1).trimStart()

	if (!before || !after) return sentence

	const ticks = before.match(/`/g)

	if (ticks && ticks.length % 2 === 1) return sentence

	let depth = 0

	for (const character of before) {
		if (character === "(" || character === "[") {
			depth++
		} else if (character === ")" || character === "]") {
			depth = Math.max(0, depth - 1)
		}
	}

	if (depth > 0) return sentence

	if (before.length < LEFT_HALF_FLOOR || !/\s/.test(before) || /[,;:([]$/.test(before)) return sentence

	const words = after.replace(/[.!?]+$/, "").split(/\s+/)

	// A coordination, a relative clause or an antithesis takes the comma the
	// sentence wanted, and keeps its own case.
	// None of them needs a verb of its own, which is why this runs ahead of the clause tests below.
	if (COMMA_OPENERS.test(after)) return words.length < COMMA_CLAUSE_FLOOR ? sentence : `${before}, ${after}`

	if (words.length < SENTENCE_CLAUSE_FLOOR) return sentence

	if (!FINITE.test(after) && !IMPERATIVES.test(after)) return sentence

	// A right half ending on its own verb is a gloss rather than a statement:
	// "the form an override uses" names the thing before the dash instead of saying
	// something new about it, and a full stop would stand a fragment up.
	if (FINITE.test(words.at(-1)!)) return sentence

	if (!OPENERS.test(after) && !IMPERATIVES.test(after) && !/^[`A-Z]/.test(after)) return sentence

	const head = /[.!?][)"'\]`]*$/.test(before) ? before : `${before}.`

	return `${head} ${openClause(after)}`
}

/**
 * Capitalise a sentence that opens in lower case, which `mailwoman/comment-reflow` needs to see a sentence.
 */
function openSentences(text: string): string {
	return text.replaceAll(/([.!?])(\s+)([a-z][a-z'’-]*)(?=\s|[.,;:)]|$)/g, (whole, stop, gap, word, offset: number) => {
		if (ABBREVIATION.test(text.slice(0, offset + 1))) return whole

		if (IDENTIFIER.test(String(word))) return whole

		return `${String(stop)}${String(gap)}${String(word).charAt(0).toUpperCase()}${String(word).slice(1)}`
	})
}

/**
 * Rewrite one paragraph, already joined to a single line.
 */
function sweepParagraph(text: string): string {
	return openSentences(text).split(SENTENCE_BOUNDARY).map(sweepSentence).join(" ")
}

/**
 * Rewrite a run of comment body lines, joining each prose paragraph into one line.
 *
 * A list item owns the indented lines beneath it, so its continuation is folded
 * into the item rather than read as a paragraph of its own.
 * Everything structural passes through untouched.
 */
function sweepBody(lines: readonly string[]): string[] {
	const output: string[] = []
	let paragraph: string[] = []
	let paragraphIndent = ""
	let item: { marker: string; text: string[] } | undefined

	const flushParagraph = () => {
		if (!paragraph.length) return

		output.push(paragraphIndent + sweepParagraph(paragraph.join(" ").replaceAll(/\s+/g, " ")))
		paragraph = []
	}

	const flushItem = () => {
		if (!item) return

		output.push(item.marker + sweepParagraph(item.text.join(" ").replaceAll(/\s+/g, " ")))
		item = undefined
	}

	for (const line of lines) {
		const list = LIST_ITEM.exec(line)

		if (item && line.trim() && /^\s+\S/.test(line) && !list) {
			item.text.push(line.trim())

			continue
		}

		if (list) {
			flushParagraph()
			flushItem()
			item = { marker: list[1]!, text: [list[2]!] }

			continue
		}

		if (!line.trim() || isStructural(line)) {
			flushParagraph()
			flushItem()
			output.push(line)

			continue
		}

		flushItem()

		if (!paragraph.length) {
			paragraphIndent = /^[\t ]*/.exec(line)![0]
		}

		paragraph.push(line.trim())
	}

	flushParagraph()
	flushItem()

	return output
}

/**
 * Lift a trailing `Returns …` or `Throws …` sentence into the tag that already carries that meaning.
 *
 * A block that already has the tag keeps its prose, since lifting it would say the same thing twice.
 * A block whose whole description is that one sentence keeps it too,
 * since lifting it would leave the symbol undescribed.
 */
function liftTagSentence(body: readonly string[], tags: readonly string[]) {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- One comment block, already resident as lines.
	const paragraphs = body.join("\n").split(/\n\s*\n/)
	const last = paragraphs.at(-1)?.trim() ?? ""
	const match = LEAD_TAG.exec(last)

	if (!match || paragraphs.length < 2 || /\n/.test(last)) return { body, tags }

	const name = match[1]!.toLowerCase() === "returns" ? "returns" : "throws"

	if (tags.some((line) => new RegExp(`^@${name}\\b`).test(line.trim()))) return { body, tags }

	const rest = last.slice(match[0].length)

	return {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- The same block, re-split after the join above.
		body: paragraphs.slice(0, -1).join("\n\n").split("\n"),
		tags: [...tags, `@${name} ${rest ? rest.charAt(0).toLowerCase() + rest.slice(1) : rest}`],
	}
}

/**
 * The character ranges a rewrite must not touch: every string, template and regular expression in the file.
 *
 * A generator that emits `// TODO(…)` inside a template literal has comment-shaped text
 * that is not a comment, and rewriting it changes what the program prints.
 * Only a parse tells the two apart.
 */
function literalSpans(source: string, fileName: string): Array<[number, number]> {
	const kind = fileName.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
	const spans: Array<[number, number]> = []

	const visit = (node: ts.Node): void => {
		if (
			ts.isStringLiteralLike(node) ||
			ts.isTemplateExpression(node) ||
			ts.isTaggedTemplateExpression(node) ||
			ts.isRegularExpressionLiteral(node)
		) {
			spans.push([node.getStart(file), node.getEnd()])

			return
		}

		ts.forEachChild(node, visit)
	}

	ts.forEachChild(file, visit)

	return spans
}

const within = (spans: ReadonlyArray<[number, number]>, offset: number) =>
	spans.some(([start, end]) => offset >= start && offset < end)

/**
 * Rewrite every comment in one source file.
 */
export function sweepSource(source: string, fileName = "file.ts"): string {
	const spans = literalSpans(source, fileName)

	const blocks = source.replaceAll(/^[\t ]*\/\*\*[\s\S]*?\*\/$/gm, (block: string, offset: number) => {
		if (within(spans, offset)) return block

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One comment block, bounded by its own markers.
		const lines = block.split("\n")

		if (lines.length < STARRED_BLOCK_LINES) return block

		const indent = /^([\t ]*)/.exec(lines[0]!)![1]!
		const stripped = lines.slice(1, -1).map((line) => /^[\t ]*\*[\t ]?(.*)$/.exec(line)?.[1])

		if (stripped.some((line) => line === undefined)) return block

		const body = stripped as string[]
		const firstTag = body.findIndex((line) => /^@\w/.test(line.trim()))
		const prose = firstTag === -1 ? body : body.slice(0, firstTag)
		const tags = firstTag === -1 ? [] : body.slice(firstTag)
		const lifted = liftTagSentence(sweepBody(prose), tags)
		const separator = lifted.tags.length && lifted.body.length ? [""] : []

		const joined = [...lifted.body, ...separator, ...lifted.tags].join("\n").replaceAll(/\n{3,}/g, "\n\n")

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- The block being rendered, still in memory.
		const rendered = joined.split("\n")

		const marked = rendered.map((line) => (line.trim() ? `${indent} * ${line}` : `${indent} *`))

		return [lines[0]!, ...marked, `${indent} */`].join("\n")
	})

	// The second pass reads the first pass's output, whose rewrites shift offsets,
	// so the spans are taken again from the text this pass actually sees.
	const shifted = literalSpans(blocks, fileName)

	return blocks.replaceAll(/(?:^[\t ]*\/\/[^\n]*\n?)+/gm, (group: string, offset: number) => {
		if (within(shifted, offset)) return group

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One run of `//` lines, bounded by the code around it.
		const lines = group.replace(/\n$/, "").split("\n")
		const indent = /^([\t ]*)/.exec(lines[0]!)![1]!
		const stripped = lines.map((line) => /^[\t ]*\/\/[\t ]?(.*)$/.exec(line)?.[1])

		if (stripped.some((line) => line === undefined)) return group

		const body = stripped as string[]

		// A directive run belongs to the linter rather than the author.
		if (body.some((line) => /^\s*(?:eslint|oxlint|prettier|@ts-|#region|#endregion|\/)/.test(line))) return group

		const marked = sweepBody(body).map((line) => (line.trim() ? `${indent}// ${line}` : `${indent}//`))

		return marked.join("\n") + (group.endsWith("\n") ? "\n" : "")
	})
}

process.exitCode = await runCLICommand(async () => {
	const paths = cliArguments()

	if (!paths.length) {
		process.stderr.write("usage: yarn comments:sweep <file> [file …]\n")

		return 1
	}

	let changed = 0

	for (const path of paths) {
		const source = await readLocalTextFile(path)
		const swept = sweepSource(source, String(path))

		if (swept === source) continue

		await writeLocalTextFile(swept, path)

		changed++
	}

	process.stdout.write(`swept ${changed} of ${paths.length} files\n`)

	return 0
})
