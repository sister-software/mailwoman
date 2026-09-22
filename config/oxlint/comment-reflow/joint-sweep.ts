#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Rewrites dash joints reported by `CommentDashJoint` directly in comments.
 *
 *   This command edits only the local dash join and keeps existing line layout.
 *   It changes the dash into a period or comma based on the right-hand clause.
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
 * Finite verbs used by the rule token.
 * Keep this list in sync with `CommentDashJoint.yml`.
 */
const VERB =
	"(?:is|are|was|were|has|have|had|does|do|did|will|would|can|could|should|must|makes|leaves|reads|names|holds|keeps|gives|takes|means|stays|comes|goes|sits|carries|returns|fires|fails|needs|wants|uses|writes|reports|answers|drops|adds|counts|costs|pays|prefers|refuses|resolves|produces|reaches|wins)"

/**
 * Words that may open the right side of a dash clause.
 */
const OPENER =
	"(?:the|a|an|it|this|that|they|we|there|each|every|its|their|these|those|both|neither|either|one|no|nothing)"

/**
 * Rule token split into left and right checks around the dash.
 */
const LEFT = new RegExp(`\\b${VERB}\\b[^—–\\n.!?;:()\\[\\]]{0,90}\\s$`, "i")
const RIGHT = new RegExp(`^${OPENER}\\s+(?:[^\\s—–,.!?;:]+\\s+){0,6}${VERB}\\b\\s`, "i")

const PREPOSITION_TAIL = /^(?:at|on|for|with|to|from|by|in|into|under|over|against|about|through|within)[.,;:)\]"'`]*$/i
const VERB_WORD = new RegExp(`^${VERB}[.,;:)\\]"'\`]*$`, "i")
const FINITE = new RegExp(`\\b${VERB}\\b`, "gi")

/**
 * Openers that usually prefer a comma instead of a sentence break.
 */
const COMMA_OPENERS =
	/^(?:which|and|but|or|nor|yet|rather|while|whereas|though|although|because|since|including|not|never|with|for|leaving|making|giving|taking)\b/i

/**
 * Max words allowed for a short gloss-like right clause.
 */
const GLOSS_CEILING = 14

/**
 * True when the right side is a short gloss of the left side.
 */
function glosses(words: readonly string[]): boolean {
	const last = words.at(-1) ?? ""

	if (!PREPOSITION_TAIL.test(last) && !VERB_WORD.test(last)) return false

	const text = words.join(" ")

	if (words.length > GLOSS_CEILING || /[,;:—–]/.test(text)) return false

	return (text.match(FINITE) ?? []).length === 1
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z`"(])/g

/**
 * True when the first word can be capitalized like normal prose.
 */
const capitalizable = (word: string) =>
	/^[a-z]/.test(word) && !/^[`[(]/.test(word) && !/[._/]/.test(word) && !/[a-z][A-Z]/.test(word)

interface Joint {
	/**
	 * Dash position in the scanned sentence.
	 */
	index: number
	/**
	 * Replacement punctuation; empty if already sentence-closed.
	 */
	punct: string
	/**
	 * Whether to capitalize the right side.
	 */
	capitalize: boolean
}

/**
 * Finds dash joints in one sentence and the punctuation to use.
 */
function jointsIn(sentence: string): Joint[] {
	const found: Joint[] = []

	for (let i = 0; i < sentence.length; i++) {
		if (sentence[i] !== "—" && sentence[i] !== "–") continue

		const before = sentence.slice(0, i).trimEnd()
		const after = sentence.slice(i + 1).trimStart()

		if (!before || !after) continue

		if (!LEFT.test(sentence.slice(0, i)) || !RIGHT.test(after)) continue

		// Skip dashes inside inline code spans.
		if ((before.match(/`/g) ?? []).length % 2 === 1) continue

		let depth = 0

		for (const character of before) {
			if (character === "(" || character === "[") {
				depth++
			} else if (character === ")" || character === "]") {
				depth = Math.max(0, depth - 1)
			}
		}

		// Skip dashes inside unmatched brackets.
		if (depth > 0) continue

		// Skip tails that start by closing a bracket.
		if (/^[^([]*[)\]]/.test(after)) continue

		if (/[,;:([]$/.test(before)) continue

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Small in-memory sentence slice.
		const words = after.replace(/[.!?]+$/, "").split(/\s+/)
		const comma = COMMA_OPENERS.test(after) || glosses(words)
		const closed = /[.!?][)"'\]`]*$/.test(before)

		found.push({ index: i, punct: comma ? "," : closed ? "" : ".", capitalize: !comma })
	}

	return found
}

/**
 * Joint edit keyed by dash order in the full comment.
 */
interface Edit {
	dash: number
	punct: string
	capitalize: boolean
}

/**
 * Scans one normalized paragraph and records joint edits by dash index.
 */
function scanParagraph(text: string, base: number, out: Edit[]): void {
	const commentDivisions: [number, string][] = []
	let last = 0

	SENTENCE_BOUNDARY.lastIndex = 0

	let match: RegExpExecArray | null

	while ((match = SENTENCE_BOUNDARY.exec(text))) {
		commentDivisions.push([last, text.slice(last, match.index)])
		last = match.index + match[0].length
	}

	commentDivisions.push([last, text.slice(last)])

	for (const [offset, sentence] of commentDivisions) {
		for (const joint of jointsIn(sentence)) {
			const at = offset + joint.index
			const dashes = (text.slice(0, at).match(/[—–]/g) ?? []).length

			out.push({ dash: base + dashes, punct: joint.punct, capitalize: joint.capitalize })
		}
	}
}

/**
 * Lines that keep their own layout and should break paragraph flow.
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

const LIST_ITEM = /^(\s{0,3}(?:[-+*]|\d+[.)])\s+)(.*)$/

const dashesIn = (line: string) => (line.match(/[—–]/g) ?? []).length

/**
 * Groups comment lines into reader-visible paragraphs, then scans them.
 *
 * Fenced blocks are skipped but still counted for dash indexing.
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

		// Keep indented continuation lines with the active paragraph.
		if (structural && !(paragraph.length && /^\s+\S/.test(line))) {
			flush()
			count += dashesIn(line)

			continue
		}

		if (!paragraph.length) {
			base = count
		}

		paragraph.push(line.trim())
		count += dashesIn(line)
	}

	flush()

	return out
}

/**
 * Capitalizes the first word at index when allowed.
 */
function capitalizeAt(text: string, index: number, capitalize: boolean): string {
	if (!capitalize) return text

	const rest = text.slice(index)
	const offset = rest.search(/\S/)

	if (offset === -1) return text

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- First word in a tiny in-memory slice.
	const word = rest.slice(offset).split(/\s/)[0] ?? ""

	if (!capitalizable(word)) return text

	const at = index + offset

	return text.slice(0, at) + text[at]!.toUpperCase() + text.slice(at + 1)
}

/**
 * Replaces one dash with chosen punctuation while preserving line layout.
 */
function applyEdit(text: string, at: number, punct: string, capitalize: boolean): string {
	const lineStart = text.lastIndexOf("\n", at) + 1
	const found = text.indexOf("\n", at)
	const lineEnd = found === -1 ? text.length : found

	if (/^[\t ]*(?:\*|\/\/)?[\t ]*$/.test(text.slice(lineStart, at))) {
		let cutEnd = at + 1

		while (cutEnd < lineEnd && /[\t ]/.test(text[cutEnd]!)) {
			cutEnd++
		}

		const previous = text.lastIndexOf("\n", lineStart - 1) + 1
		let insert = lineStart - 1

		while (insert > previous && /\s/.test(text[insert - 1]!)) {
			insert--
		}

		const head = text.slice(0, insert) + punct + text.slice(insert, at)

		return capitalizeAt(head + text.slice(cutEnd), head.length, capitalize)
	}

	let cutStart = at
	let cutEnd = at + 1
	let filler = ""

	while (cutStart > lineStart && /[\t ]/.test(text[cutStart - 1]!)) {
		cutStart--
	}

	if (!/^[\t ]*$/.test(text.slice(at + 1, lineEnd))) {
		while (cutEnd < lineEnd && /[\t ]/.test(text[cutEnd]!)) {
			cutEnd++
		}

		filler = " "
	}

	const head = text.slice(0, cutStart) + punct + filler

	return capitalizeAt(head + text.slice(cutEnd), head.length, capitalize)
}

/**
 * Returns ranges for string/template/regex literals to skip.
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
 * Rewrites one comment using its logical lines and raw source text.
 */
function rewrite(raw: string, lines: readonly string[]): string {
	const edits = scanLines(lines)

	if (!edits.length) return raw

	const positions: number[] = []

	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "—" || raw[i] === "–") {
			positions.push(i)
		}
	}

	let out = raw

	// Apply edits from the end so offsets stay valid.
	for (const edit of [...edits].toSorted((a, b) => b.dash - a.dash)) {
		const at = positions[edit.dash]

		if (at === undefined) continue

		out = applyEdit(out, at, edit.punct, edit.capitalize)
	}

	return out
}

/**
 * Rewrites all detected joints in comments for one file.
 */
export function sweepSource(source: string, fileName: string): string {
	const spans = literalSpans(source, fileName)

	const blocks = source.replaceAll(/^[\t ]*\/\*[\s\S]*?\*\/$/gm, (block: string, offset: number) => {
		if (within(spans, offset)) return block

		// Skip shipped banner comments.
		if (block.trimStart().startsWith("/*!")) return block

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Single bounded block comment.
		const raw = block.split("\n")

		if (raw.length === 1) {
			const single = /^[\t ]*\/\*\*?[\t ]?([\s\S]*?)[\t ]?\*\/$/.exec(block)

			return single ? rewrite(block, [single[1]!]) : block
		}

		const lines = raw.slice(1, -1).map((line) => /^[\t ]*\*[\t ]?(.*)$/.exec(line)?.[1] ?? line.trim())

		return rewrite(block, [raw[0]!.replace(/^[\t ]*\/\*\*?[\t ]?/, ""), ...lines])
	})

	// Recompute literal spans after block edits shift offsets.
	const shifted = literalSpans(blocks, fileName)

	return blocks.replaceAll(/(?:^[\t ]*\/\/[^\n]*\n?)+/gm, (group: string, offset: number) => {
		if (within(shifted, offset)) return group

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Single contiguous `//` group.
		const raw = group.replace(/\n$/, "").split("\n")
		const lines = raw.map((line) => /^[\t ]*\/\/[\t ]?(.*)$/.exec(line)?.[1])

		if (lines.some((line) => line === undefined)) return group

		const body = lines as string[]

		// Skip directive-style comment runs.
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
