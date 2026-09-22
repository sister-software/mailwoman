#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The joint sweep: the dash joints `CommentDashJoint` reports, answered in place.
 *
 *   `comments:sweep` converts a joint by rewriting the sentence and handing the paragraph back to
 *   `mailwoman/comment-reflow` to re-break. That leaves out every comment the rule will not touch, and a legal
 *   header is one of them: joining its paragraphs produces a single 700-column line nothing will ever break again.
 *
 *   This pass uses the Vale rule's own token, so what it leaves behind is exactly what the rule reports. The edit
 *   is local. The dash and the space holding it become a full stop, or a comma where the right half glosses the left
 *   rather than standing on its own, and the author's line structure is untouched. Run `yarn fix:oxlint` afterwards
 *   so the rule can re-break the paragraphs it does own.
 *
 *   Usage: `yarn comments:joints <file> [file …]`.
 */

/// <reference types="node" />

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import ts from "typescript"

/**
 * The finite verbs the rule's token recognizes.
 *
 * It is a closed list rather than a part-of-speech test, and `CommentDashJoint.yml` carries the same one.
 * A verb added to one belongs in the other, or the rule reports a joint this script cannot answer.
 */
const VERB =
	"(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|should|must|makes|leaves|reads|names|holds|keeps|gives|takes|means|stays|comes|goes|sits|carries|returns|fires|fails|needs|wants|uses|writes|reports|answers|drops|adds|counts|costs|pays|prefers|refuses|resolves|produces|reaches|wins)"

/**
 * The determiners a clause behind the dash can open with.
 */
const OPENER =
	"(?:the|a|an|it|this|that|they|we|there|each|every|its|their|these|those|both|neither|either|one|no|nothing)"

/**
 * The rule's token, split at the dash so each half can be tested against one side of a candidate.
 */
const LEFT = new RegExp(`\\b${VERB}\\b[^—–\\n.!?;:()\\[\\]]{0,90}\\s$`, "i")
const RIGHT = new RegExp(`^${OPENER}\\s+(?:[^\\s—–,.!?;:]+\\s+){0,6}${VERB}\\b\\s`, "i")

const PREPOSITION_TAIL = /^(?:at|on|for|with|to|from|by|in|into|under|over|against|about|through|within)[.,;:)\]"'`]*$/i
const VERB_WORD = new RegExp(`^${VERB}[.,;:)\\]"'\`]*$`, "i")
const FINITE = new RegExp(`\\b${VERB}\\b`, "gi")

/**
 * A clause that cannot open a sentence, but reads correctly once the dash is a comma.
 *
 * `which` opens a relative clause and `and` a coordination, so a full stop in front
 * of either stands a fragment up where the sentence only wanted a comma.
 */
const COMMA_OPENERS =
	/^(?:which|and|but|or|nor|yet|rather|while|whereas|though|although|because|since|including|not|never|with|for|leaving|making|giving|taking)\b/i

/**
 * True when the right half names the thing before the dash rather than saying something new about it.
 *
 * "the scale the map units were digitized at" and "the form an override uses" are noun phrases with a
 * relative clause hanging off them, and a full stop in front of either stands a fragment up.
 * The comma is what the sentence wanted.
 *
 * The gloss is short and holds one verb: a longer right half, or one carrying a second clause,
 * is a sentence whose last word merely happens to be a verb or a stranded preposition.
 */
function glosses(words: readonly string[]): boolean {
	const last = words.at(-1) ?? ""

	if (!PREPOSITION_TAIL.test(last) && !VERB_WORD.test(last)) return false

	const text = words.join(" ")

	if (words.length > 14 || /[,;:—–]/.test(text)) return false

	return (text.match(FINITE) ?? []).length === 1
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z`"(])/g

/**
 * A word that starts a sentence in upper case.
 * Code names keep the spelling the thing they name has.
 */
const capitalizable = (word: string) =>
	/^[a-z]/.test(word) && !/^[`[(]/.test(word) && !/[._/]/.test(word) && !/[a-z][A-Z]/.test(word)

interface Joint {
	/**
	 * Position of the dash within the text it was found in.
	 */
	index: number
	/**
	 * What the dash becomes.
	 * Empty when the left half already closes with a full stop.
	 */
	punct: string
	/**
	 * Whether the right half opens a sentence of its own.
	 */
	capitalize: boolean
}

/**
 * Every dash in a sentence the rule's token reads as a joint, with the punctuation it should carry instead.
 */
function jointsIn(sentence: string): Joint[] {
	const found: Joint[] = []

	for (let i = 0; i < sentence.length; i++) {
		if (sentence[i] !== "—" && sentence[i] !== "–") continue

		const before = sentence.slice(0, i).trimEnd()
		const after = sentence.slice(i + 1).trimStart()

		if (!before || !after) continue

		if (!LEFT.test(sentence.slice(0, i)) || !RIGHT.test(after)) continue

		// A dash inside a code span is punctuation in something else's language.
		if ((before.match(/`/g) ?? []).length % 2 === 1) continue

		let depth = 0

		for (const character of before) {
			if (character === "(" || character === "[") { depth++ }
			else if (character === ")" || character === "]") { depth = Math.max(0, depth - 1) }
		}

		// A dash inside a bracket belongs to the aside, and a full stop there closes a sentence the bracket has not.
		if (depth > 0) continue

		// A right half that closes a bracket it did not open is the tail of one.
		if (/^[^([]*[)\]]/.test(after)) continue

		if (/[,;:([]$/.test(before)) continue

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One sentence's right half, already in memory.
		const words = after.replace(/[.!?]+$/, "").split(/\s+/)
		const comma = COMMA_OPENERS.test(after) || glosses(words)
		const closed = /[.!?][)"'\]`]*$/.test(before)

		found.push({ index: i, punct: comma ? "," : closed ? "" : ".", capitalize: !comma })
	}

	return found
}

/**
 * A joint, keyed by which dash of the whole comment it sits on.
 */
interface Edit {
	dash: number
	punct: string
	capitalize: boolean
}

/**
 * Scan one paragraph, already joined to a single line, and key its joints to the comment's dash order.
 */
function scanParagraph(text: string, base: number, out: Edit[]): void {
	const cuts: [number, string][] = []
	let last = 0

	SENTENCE_BOUNDARY.lastIndex = 0

	let match: RegExpExecArray | null

	while ((match = SENTENCE_BOUNDARY.exec(text))) {
		cuts.push([last, text.slice(last, match.index)])
		last = match.index + match[0].length
	}

	cuts.push([last, text.slice(last)])

	for (const [offset, sentence] of cuts) {
		for (const joint of jointsIn(sentence)) {
			const at = offset + joint.index
			const dashes = (text.slice(0, at).match(/[—–]/g) ?? []).length

			out.push({ dash: base + dashes, punct: joint.punct, capitalize: joint.capitalize })
		}
	}
}

/**
 * A line that carries its own layout, in `mailwoman/comment-reflow`'s own terms.
 *
 * The rule's test is copied here rather than approximated, so the paragraphs this
 * script reads are the paragraphs that rule sees.
 */
const STRUCTURAL_LINE: readonly RegExp[] = [
	/^\s*https?:\/\/\S+\s*$/i,
	/^(?:\s{4}|\t|\s*[*+-]\s|\s*\d+[.)]\s|\s*[#>|]|\s*\[[^\]]+\]:|\s*(?:---+|===+)\s*$|\s*`{3}|\s*~{3}|\s*@)/,
	/^\s*<(?:[!?]|[^>]*$|.*>\s*$)/,
	/(?: {2}|\\)$/,
	/^\s*type\s+[\w$]+(?:\s*<.*>)?\s*=/,
	/^\s*(?:const |let |var |function |class |import |export |return |if\s*\(|\/\/|\{(?!@)|\})/,
	/^[^{}[\]`]*\s\|\s|^[\w.$]+\(.*\)[;]?$|^[\w.$]+\s*=\s*\S/,
]

const LIST_ITEM = /^(\s{0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/

const dashesIn = (line: string) => (line.match(/[—–]/g) ?? []).length

/**
 * Group a comment's logical lines into the paragraphs a reader sees, and scan each one.
 *
 * A fenced block is passed over whole, because its dashes belong to whatever language it holds.
 * Every line is counted whether it is scanned or not, so the dash index stays
 * in step with the raw text the edits land on.
 */
function scanLines(lines: readonly string[]): Edit[] {
	const out: Edit[] = []
	let count = 0
	let paragraph: string[] = []
	let base = 0
	let fenced = false

	const flush = () => {
		if (!paragraph.length) return

		scanParagraph(paragraph.join(" ").replaceAll(/\s+/g, " "), base, out)
		paragraph = []
	}

	for (const line of lines) {
		if (/^\s*(?:`{3}|~{3})/.test(line)) {
			flush()
			fenced = !fenced
			count += dashesIn(line)

			continue
		}

		if (fenced) {
			count += dashesIn(line)

			continue
		}

		const item = LIST_ITEM.exec(line)

		if (item) {
			flush()
			base = count + dashesIn(item[1]!)
			paragraph = [item[2]!]
			count += dashesIn(line)

			continue
		}

		const structural = !line.trim() || STRUCTURAL_LINE.some((pattern) => pattern.test(line))

		// An indented line under an open paragraph continues it, which is where a file header keeps its argument.
		if (structural && !(paragraph.length && /^\s+\S/.test(line))) {
			flush()
			count += dashesIn(line)

			continue
		}

		if (!paragraph.length) { base = count }

		paragraph.push(line.trim())
		count += dashesIn(line)
	}

	flush()

	return out
}

/**
 * Open the right half in upper case, unless its first word is code or already capitalized.
 */
function capitalizeAt(text: string, index: number, capitalize: boolean): string {
	if (!capitalize) return text

	const rest = text.slice(index)
	const offset = rest.search(/\S/)

	if (offset === -1) return text

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- The first word of a right half, already in memory.
	const word = rest.slice(offset).split(/\s/)[0] ?? ""

	if (!capitalizable(word)) return text

	const at = index + offset

	return text.slice(0, at) + text[at]!.toUpperCase() + text.slice(at + 1)
}

/**
 * Replace one dash, and the space holding it, with the punctuation the sentence wanted.
 *
 * The comment's line structure is the author's, so the edit stays inside the dash's own line:
 * a dash between two words closes up to one space, a dash at the end of a line leaves the next line
 * where it is, and a dash at the head of a continuation line puts its punctuation back on the line above.
 * Nothing here re-wraps.
 */
function applyEdit(text: string, at: number, punct: string, capitalize: boolean): string {
	const lineStart = text.lastIndexOf("\n", at) + 1
	const found = text.indexOf("\n", at)
	const lineEnd = found === -1 ? text.length : found

	if (/^[\t ]*(?:\*|\/\/)?[\t ]*$/.test(text.slice(lineStart, at))) {
		let cutEnd = at + 1

		while (cutEnd < lineEnd && /[\t ]/.test(text[cutEnd]!)) { cutEnd++ }

		const previous = text.lastIndexOf("\n", lineStart - 1) + 1
		let insert = lineStart - 1

		while (insert > previous && /\s/.test(text[insert - 1]!)) { insert-- }

		const head = text.slice(0, insert) + punct + text.slice(insert, at)

		return capitalizeAt(head + text.slice(cutEnd), head.length, capitalize)
	}

	let cutStart = at
	let cutEnd = at + 1
	let filler = ""

	while (cutStart > lineStart && /[\t ]/.test(text[cutStart - 1]!)) { cutStart-- }

	if (!/^[\t ]*$/.test(text.slice(at + 1, lineEnd))) {
		while (cutEnd < lineEnd && /[\t ]/.test(text[cutEnd]!)) { cutEnd++ }
		filler = " "
	}

	const head = text.slice(0, cutStart) + punct + filler

	return capitalizeAt(head + text.slice(cutEnd), head.length, capitalize)
}

/**
 * The source ranges a string, template or regular expression owns,
 * which hold text this script must not read.
 */
function literalSpans(source: string, fileName: string): [number, number][] {
	const kind = fileName.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
	const spans: [number, number][] = []

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

const within = (spans: readonly [number, number][], offset: number) =>
	spans.some(([start, end]) => offset >= start && offset < end)

/**
 * Rewrite one comment, given the logical lines a reader sees and the raw text they came from.
 */
function rewrite(raw: string, lines: readonly string[]): string {
	const edits = scanLines(lines)

	if (!edits.length) return raw

	const positions: number[] = []

	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "—" || raw[i] === "–") { positions.push(i) }
	}

	let out = raw

	// Last dash first, so an earlier edit never moves a later one's offset.
	for (const edit of [...edits].toSorted((a, b) => b.dash - a.dash)) {
		const at = positions[edit.dash]

		if (at === undefined) continue

		out = applyEdit(out, at, edit.punct, edit.capitalize)
	}

	return out
}

/**
 * Rewrite every joint in one file's comments.
 */
export function sweepSource(source: string, fileName: string): string {
	const spans = literalSpans(source, fileName)

	const blocks = source.replaceAll(/^[\t ]*\/\*[\s\S]*?\*\/$/gm, (block: string, offset: number) => {
		if (within(spans, offset)) return block

		// A shipped banner is copied text rather than this repository's prose.
		if (block.trimStart().startsWith("/*!")) return block

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One block comment, bounded by its own markers.
		const raw = block.split("\n")

		if (raw.length === 1) {
			const single = /^[\t ]*\/\*\*?[\t ]?([\s\S]*?)[\t ]?\*\/$/.exec(block)

			return single ? rewrite(block, [single[1]!]) : block
		}

		const lines = raw.slice(1, -1).map((line) => /^[\t ]*\*[\t ]?(.*)$/.exec(line)?.[1] ?? line.trim())

		return rewrite(block, [raw[0]!.replace(/^[\t ]*\/\*\*?[\t ]?/, ""), ...lines])
	})

	// The first pass's rewrites shift offsets, so the spans are taken again from the text this pass sees.
	const shifted = literalSpans(blocks, fileName)

	return blocks.replaceAll(/(?:^[\t ]*\/\/[^\n]*\n?)+/gm, (group: string, offset: number) => {
		if (within(shifted, offset)) return group

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One run of `//` lines, bounded by the code around it.
		const raw = group.replace(/\n$/, "").split("\n")
		const lines = raw.map((line) => /^[\t ]*\/\/[\t ]?(.*)$/.exec(line)?.[1])

		if (lines.some((line) => line === undefined)) return group

		const body = lines as string[]

		// A directive run belongs to the linter rather than the author.
		if (body.some((line) => /^\s*(?:\/|#region|#endregion)/.test(line))) return group

		return rewrite(group.replace(/\n$/, ""), body) + (group.endsWith("\n") ? "\n" : "")
	})
}

process.exitCode = await runCLICommand(async () => {
	const paths = [...cliArguments()]

	if (!paths.length) {
		process.stderr.write("usage: yarn comments:joints <file> [file …]\n")

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

	process.stdout.write(`answered joints in ${changed} of ${paths.length} files\n`)

	return 0
})
