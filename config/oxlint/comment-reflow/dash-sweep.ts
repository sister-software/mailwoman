#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The dash sweep: comment sentences that join two clauses with a dash, rewritten as two sentences.
 *
 *   `CommentSemicolons` closed the semicolon at error level and nothing closed the dash, so a sentence that wanted to
 *   join two independent clauses reached for one instead. The count at the time this landed was 33 semicolons in
 *   comments against roughly 7,400 dashes doing a semicolon's work.
 *
 *   Only that use moves. A paired dash around an aside stays, and so does a dash introducing a noun phrase. Roughly a
 *   third of the joints convert; what is left is appositive, or has a right-hand clause opening with a word that
 *   cannot start a sentence, and both want an author rather than a script.
 *
 *   Paragraphs are joined before rewriting and emitted as one line each. `mailwoman/comment-reflow` re-breaks them
 *   afterwards, so line layout is deliberately not this script's business: run `yarn fix:oxlint` after a sweep.
 */

/// <reference types="node" />

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"

const FINITE =
	/\b(is|are|was|were|be|been|has|have|had|does|do|did|will|would|can|could|should|must|makes?|leaves?|reads?|names?|holds?|keeps?|gives?|takes?|means?|stays?|comes?|goes?|sits?|carries|carry|returns?|fires?|fails?|needs?|wants?|uses?|writes?|reports?|answers?|drops?|adds?|counts?|costs?|buys?|pays?|prefers?|refuses?|never|only|already|still)\b/i

/**
 * Words a clause can open a sentence with.
 *
 * `so` and `unlike` are here because a dash in front of either is the same joint under another name, and both read as
 * openers once the dash is a full stop.
 */
const OPENERS =
	/^(?:the|a|an|it|this|that|they|we|you|there|each|every|nothing|nobody|its|their|those|these|both|neither|either|one|most|some|any|no|so|unlike|without|once|when|if|after|before|together|instead|otherwise)\b/i

/** A line that carries its own layout: a list item, a fence, a tag, an indented block, a table row. */
const STRUCTURAL = /^(?:\s{4}|\t|\s*[*+->|]\s|\s*\d+[.)]\s|\s*#{1,6}\s|\s*`{3}|\s*~{3}|\s*\[[^\]]+\]:|@)/

const LIST_ITEM = /^(\s{0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z`"(])/

const ABBREVIATION = /(?:^|\s)(?:e\.g\.|i\.e\.|etc\.|vs\.|cf\.|ca\.|approx\.|no\.|fig\.|eq\.|al\.|[A-Z]\.)$/i

const LEAD_TAG = /^(Returns|Throws)\b\s+/

const IDENTIFIER = /[._/]|[a-z][A-Z]/

/** Capitalise a clause that is becoming a sentence, unless its first word names something. */
function openClause(clause: string): string {
	const [first = ""] = clause.split(/\s+/)
	if (!/^[a-z]/.test(first)) return clause
	// `foo`, foo.bar, fooBar and foo_bar are names. Capitalising one would name something that does not exist.
	if (/^[`[(]/.test(first) || IDENTIFIER.test(first)) return clause
	return first.charAt(0).toUpperCase() + clause.slice(1)
}

/**
 * Rewrite one sentence whose dash is doing a semicolon's work, or return it as it stands.
 *
 * Every guard here is a reason to leave the sentence alone: a dash inside a code span or a bracket belongs to
 * something else's grammar, a short left half cannot stand as a sentence, and a right half without a finite verb is an
 * apposition rather than a clause.
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
		if (character === "(" || character === "[") depth++
		else if (character === ")" || character === "]") depth = Math.max(0, depth - 1)
	}

	if (depth > 0) return sentence
	if (before.length < 24 || !/\s/.test(before) || /[,;:([]$/.test(before)) return sentence

	const words = after.replace(/[.!?]+$/, "").split(/\s+/)

	if (words.length < 5 || !FINITE.test(after)) return sentence
	if (!OPENERS.test(after) && !/^[`A-Z]/.test(after)) return sentence

	const head = /[.!?][)"'\]`]*$/.test(before) ? before : `${before}.`

	return `${head} ${openClause(after)}`
}

/**
 * Capitalise a sentence that opens in lower case.
 *
 * Nothing downstream can tell one of these from a clause. The reflow rule needs the capital to see a sentence, and a
 * reader needs it for the same reason.
 */
function openSentences(text: string): string {
	return text.replace(/([.!?])(\s+)([a-z][a-z'’-]*)(?=\s|[.,;:)]|$)/g, (whole, stop, gap, word, offset: number) => {
		if (ABBREVIATION.test(text.slice(0, offset + 1))) return whole
		if (IDENTIFIER.test(String(word))) return whole

		return `${String(stop)}${String(gap)}${String(word).charAt(0).toUpperCase()}${String(word).slice(1)}`
	})
}

/** Rewrite one paragraph, already joined to a single line. */
function sweepParagraph(text: string): string {
	return openSentences(text).split(SENTENCE_BOUNDARY).map(sweepSentence).join(" ")
}

/**
 * Rewrite a run of comment body lines, joining each prose paragraph into one line.
 *
 * A list item owns the indented lines beneath it, so its continuation is folded into the item rather than read as a
 * paragraph of its own. Everything structural passes through untouched.
 */
function sweepBody(lines: readonly string[]): string[] {
	const output: string[] = []
	let paragraph: string[] = []
	let paragraphIndent = ""
	let item: { marker: string; text: string[] } | undefined

	const flushParagraph = () => {
		if (!paragraph.length) return

		output.push(paragraphIndent + sweepParagraph(paragraph.join(" ").replace(/\s+/g, " ")))
		paragraph = []
	}

	const flushItem = () => {
		if (!item) return

		output.push(item.marker + sweepParagraph(item.text.join(" ").replace(/\s+/g, " ")))
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

		if (!line.trim() || STRUCTURAL.test(line)) {
			flushParagraph()
			flushItem()
			output.push(line)
			continue
		}

		flushItem()

		if (!paragraph.length) paragraphIndent = /^[\t ]*/.exec(line)![0]

		paragraph.push(line.trim())
	}

	flushParagraph()
	flushItem()

	return output
}

/**
 * Lift a trailing `Returns …` or `Throws …` sentence into the tag that already carries that meaning.
 *
 * A block that already has the tag keeps its prose, since the lift would say it twice. A block whose whole description
 * is that one sentence keeps it too, since the lift would leave the symbol undescribed.
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

/** Rewrite every comment in one source file. */
export function sweepSource(source: string): string {
	const blocks = source.replace(/^[\t ]*\/\*\*[\s\S]*?\*\/$/gm, (block) => {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One comment block, bounded by its own markers.
		const lines = block.split("\n")

		if (lines.length < 3) return block

		const indent = /^([\t ]*)/.exec(lines[0]!)![1]!
		const stripped = lines.slice(1, -1).map((line) => /^[\t ]*\*[\t ]?(.*)$/.exec(line)?.[1])

		if (stripped.some((line) => line === undefined)) return block

		const body = stripped as string[]
		const firstTag = body.findIndex((line) => /^@\w/.test(line.trim()))
		const prose = firstTag === -1 ? body : body.slice(0, firstTag)
		const tags = firstTag === -1 ? [] : body.slice(firstTag)
		const lifted = liftTagSentence(sweepBody(prose), tags)
		const separator = lifted.tags.length && lifted.body.length ? [""] : []
		const rendered = [...lifted.body, ...separator, ...lifted.tags]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- The block being rendered, still in memory.
			.split("\n")

		const marked = rendered.map((line) => (line.trim() ? `${indent} * ${line}` : `${indent} *`))

		return [lines[0]!, ...marked, `${indent} */`].join("\n")
	})

	return blocks.replace(/(?:^[\t ]*\/\/[^\n]*\n?)+/gm, (group) => {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One run of `//` lines, bounded by the code around it.
		const lines = group.replace(/\n$/, "").split("\n")
		const indent = /^([\t ]*)/.exec(lines[0]!)![1]!
		const stripped = lines.map((line) => /^[\t ]*\/\/[\t ]?(.*)$/.exec(line)?.[1])

		if (stripped.some((line) => line === undefined)) return group

		const body = stripped as string[]

		// A directive run is the linter's, not the author's.
		if (body.some((line) => /^\s*(?:eslint|oxlint|prettier|@ts-|#region|#endregion|\/)/.test(line))) return group

		const marked = sweepBody(body).map((line) => (line.trim() ? `${indent}// ${line}` : `${indent}//`))

		return marked.join("\n") + (group.endsWith("\n") ? "\n" : "")
	})
}

process.exitCode = await runCLICommand(async () => {
	const paths = [...cliArguments()]

	if (!paths.length) {
		process.stderr.write("usage: yarn comments:sweep <file> [file …]\n")
		return 1
	}

	let changed = 0

	for (const path of paths) {
		const source = await readLocalTextFile(path)
		const swept = sweepSource(source)

		if (swept === source) continue

		await writeLocalTextFile(swept, path)
		changed++
	}

	process.stdout.write(`swept ${changed} of ${paths.length} files\n`)

	return 0
})
