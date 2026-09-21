/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Comment reflow: paragraph detection, markup preservation, and the line breaker.
 *
 * Paragraph detection, markup preservation and the rule plumbing began as oxlint-plugin-comment-reflow (MIT,
 * © Diego Haz). The line breaker is ours: upstream fills greedily to one width, which is what produced the
 * orphans and the mid-parenthetical breaks. See `chooseBreaks` for the penalty model that replaced it.
 */

/** Options for the comment-reflow rule. */
export interface ReflowOptions {
	/**
	 * Hard ceiling.
	 *
	 * No produced line exceeds it except an unbreakable token.
	 * Default: 120.
	 */
	printWidth?: number
	/**
	 * The width prose aims for.
	 *
	 * Everything between it and `printWidth` is the balance zone.
	 * Default: 90.
	 */
	targetWidth?: number
	/**
	 * Columns a tab advances.
	 * Default: 2, matching oxfmt.
	 */
	tabWidth?: number
	/**
	 * Sentences a paragraph may hold after the lead.
	 * Default: 2.
	 */
	paragraphSentences?: number
	/**
	 * Placement of eligible trailing comments.
	 * Default: "overflow".
	 */
	trailingComments?: "ignore" | "always" | "overflow"
}

export const defaultOptions: Required<ReflowOptions> = {
	printWidth: 120,
	targetWidth: 90,
	tabWidth: 2,
	paragraphSentences: 2,
	trailingComments: "overflow",
}

/**
 * Penalties in the breaker's cost function.
 * Tuned against the monorepo's own comments.
 */
export const weights = {
	/** Squared cost per column a line falls short of the target. */
	short: 1,
	/** Squared cost per column a line runs into the balance zone, for the first `zone` columns of it. */
	over: 2,
	/** Columns of balance zone charged at the gentle rate before the steep one takes over. */
	zone: 10,
	/** Squared cost per column past `target + zone`, which is where lines start to look long. */
	overFar: 8,
	/** The last line is charged this fraction of the shortfall, so a paragraph ends balanced, not stranded. */
	lastShort: 0.25,
	/** Flat cost per line, so an equal-cost break with fewer lines wins. */
	line: 12,
	/**
	 * Breaking with a parenthesis still open.
	 * Buys roughly 17 columns of overrun.
	 */
	parenSplit: 1200,
	/** Credit for breaking after a comma, a dash, or before a conjunction. */
	clause: -130,
	/** Starting a line with a dash, so an em dash stays with the clause it followed. */
	danglingDash: 700,
	/** A last line holding one short word. */
	orphan: 2400,
	/** A last line shorter than this many columns of content counts as an orphan. */
	orphanColumns: 24,
	/** A trailing sentence shorter than this many characters joins the paragraph before it rather than standing alone. */
	orphanParagraph: 60,
} as const

/** Count Unicode code points; a tab advances to the next `tabWidth` stop. */
export function columns(text: string, tabWidth: number = defaultOptions.tabWidth): number {
	let width = 0
	for (const character of text) {
		width += character === "\t" ? tabWidth - (width % tabWidth) : 1
	}
	return width
}

/**
 * Comments carrying a tool directive or legal text must remain byte-for-byte intact.
 *
 * The tool names are only half of a directive, so each has to be followed by the word that makes it one.
 * Upstream matched the name alone, which made every comment citing `…-v8-cjk-regs.md` or a Vite
 * config protected, and a protected comment is one this rule never touches and never reports.
 */
export function isProtected(text: string): boolean {
	const directive =
		/\b(?:eslint|oxlint|biome|prettier|oxfmt|stylelint|jshint|jslint|istanbul|c8|v8|vitest|webpack|vite|rollup|parcel|coverage|tslint|deno-lint)[-\s:]*(?:ignore|disable|enable|expect|skip|environment|chunk|exports|include|exclude|preserve|prefetch|preload|mode|no-)/i
	const legal =
		/@(?:ts-|jsx|flow\b|noflow\b|license\b|preserve\b|copyright\b|cc_on\b)|[#@]__[A-Z_]+__|[#@]\s*source(?:Mapping)?URL\s*=|\b(?:copyright|SPDX-License-Identifier|@license)\b|^\s*(?:global[s]?\s|exported\s|<reference\s|<amd-|!|:|#?region\b|#?endregion\b|language\s*=)/im
	return directive.test(text) || legal.test(text)
}

// Read balanced inline constructs without changing their internal whitespace.
function balancedEnd(text: string, start: number, open: string, close: string, quoteStrings = false) {
	let depth = 0
	let quote = ""
	for (let i = start; i < text.length; i++) {
		const character = text[i]
		if (character === "\\") {
			i++
			continue
		}
		if (quote) {
			if (character === quote) quote = ""
			continue
		}
		if (quoteStrings && (character === '"' || character === "'" || character === "`")) {
			quote = character
			continue
		}
		if (character === open) depth++
		if (character === close && --depth === 0) return i + 1
	}
	return undefined
}

function words(text: string): string[] | undefined {
	const result: string[] = []
	let word = ""
	for (let i = 0; i < text.length;) {
		const character = text[i]!
		if (/\s/.test(character)) {
			if (word) result.push(word)
			word = ""
			i++
			continue
		}
		let end: number | undefined
		if (character === "`") {
			const delimiter = /^`+/.exec(text.slice(i))![0]
			const close = text.indexOf(delimiter, i + delimiter.length)
			if (close < 0) return undefined
			end = close + delimiter.length
		} else if (text.startsWith("{@", i)) {
			end = balancedEnd(text, i, "{", "}")
			if (!end) return undefined
		} else if (character === "[") {
			end = balancedEnd(text, i, "[", "]")
			if (!end) return undefined
			if (text[end] === "(" || text[end] === "[") {
				end = balancedEnd(text, end, text[end]!, text[end] === "(" ? ")" : "]")
				if (!end) return undefined
			}
		}
		if (end) {
			word += text.slice(i, end)
			i = end
		} else {
			word += character
			i++
		}
	}
	if (word) result.push(word)
	return result
}

/** Widths the breaker works to, in columns of comment content (markers and indent already subtracted). */
export interface WrapLimits {
	target: number
	max: number
	tabWidth: number
}

/**
 * An abbreviation ending in a period is not a sentence boundary.
 *
 * The list is the ones that actually occur in this repository's prose; a missed
 * entry costs a break opportunity, never a mangled sentence.
 */
const ABBREVIATIONS =
	/^(?:e\.g\.|i\.e\.|etc\.|vs\.|cf\.|ca\.|approx\.|no\.|fig\.|eq\.|al\.|Mr\.|Mrs\.|Ms\.|Dr\.|St\.|Inc\.|Ltd\.|(?:[A-Z]\.)+)$/

/** Words that open a clause: breaking just before one reads as a deliberate seam. */
const CONJUNCTIONS = new Set([
	"and",
	"but",
	"or",
	"nor",
	"so",
	"yet",
	"because",
	"which",
	"while",
	"though",
	"although",
	"since",
	"unless",
	"until",
	"whereas",
	"whether",
	"when",
	"where",
	"after",
	"before",
	"rather",
	"instead",
	"then",
])

const DASH = /^[—–-]$/

/** A wrap must not create a new JSDoc tag, list item, or Markdown heading. */
function isStructuralToken(token: string) {
	return /^(?:@|[-+*>]$|#{1,6}$|\d+[.)]$|`{3}|~{3})/.test(token)
}

interface TokenFacts {
	/** Column width of the token itself. */
	width: number
	/** Open parentheses and brackets left behind after this token. */
	depth: number
	/** This token ends a clause, or the next one opens one. */
	clause: boolean
	/** The next token leads with a dash, which must not start a line. */
	danglingDash: boolean
	/** The next token may not start a line. */
	glued: boolean
}

function measure(tokens: readonly string[], tabWidth: number): TokenFacts[] {
	let depth = 0
	return tokens.map((token, index) => {
		for (const character of token) {
			if (character === "(" || character === "[") depth++
			else if (character === ")" || character === "]") depth = Math.max(0, depth - 1)
		}
		const next = tokens[index + 1]
		const clause =
			/[,;:][)"'\]`]*$/.test(token) ||
			DASH.test(token) ||
			(next !== undefined && CONJUNCTIONS.has(next.toLowerCase().replace(/[^a-z]/g, "")))
		return {
			width: columns(token, tabWidth),
			depth,
			clause,
			danglingDash: next !== undefined && /^[—–]/.test(next),
			glued: next !== undefined && isStructuralToken(next),
		}
	})
}

/**
 * Set one sentence, choosing its breaks by minimizing a penalty over every legal breaking
 * rather than filling each line until the next word does not fit.
 *
 * Greedy filling is what strands a two-word tail on a line of its own and what cuts a parenthetical in half.
 * It cannot price a break until it has already taken it.
 *
 * A line wants to end at `target`.
 * Falling short costs the square of the gap.
 *
 * Running into the balance zone up to `max` costs twice that square, and eight times
 * it past ten columns in, so those columns are bought rather than spent.
 * A parenthetical that would otherwise be split is worth about seventeen of them.
 *
 * Breaking after a comma or before a conjunction earns a credit, which is what puts the seam on punctuation.
 */
function chooseBreaks(tokens: readonly string[], limits: WrapLimits, firstWidth: number, continuationWidth: number) {
	const facts = measure(tokens, limits.tabWidth)
	const count = tokens.length
	// prefix[i] is the width of tokens 0..i-1 joined by single spaces.
	const prefix: number[] = [0]
	for (let i = 0; i < count; i++) prefix.push(prefix[i]! + facts[i]!.width + (i > 0 ? 1 : 0))
	const lineWidth = (from: number, to: number) =>
		(from === 0 ? firstWidth : continuationWidth) + prefix[to]! - prefix[from]! - (from > 0 ? 1 : 0)

	// Cost of setting tokens [from, to) as one line, `last` when nothing follows it.
	const cost = (from: number, to: number, last: boolean) => {
		const width = lineWidth(from, to)
		if (width > limits.max && to - from > 1) return Number.POSITIVE_INFINITY
		let penalty = weights.line
		const gap = width - limits.target
		if (gap <= 0) {
			penalty += (last ? weights.lastShort : 1) * weights.short * gap * gap
		} else {
			const gentle = Math.min(gap, weights.zone)
			const far = gap - gentle
			penalty += weights.over * gentle * gentle + weights.overFar * far * far
		}
		if (last) {
			const content = width - (from === 0 ? firstWidth : continuationWidth)
			if (from > 0 && (to - from === 1 || content < weights.orphanColumns)) penalty += weights.orphan
			return penalty
		}
		const boundary = facts[to - 1]!
		if (boundary.depth > 0) penalty += weights.parenSplit
		if (boundary.clause) penalty += weights.clause
		if (boundary.danglingDash) penalty += weights.danglingDash
		return penalty
	}

	const best = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY)
	const from = new Array<number>(count + 1).fill(0)
	best[0] = 0
	for (let to = 1; to <= count; to++) {
		for (let start = to - 1; start >= 0; start--) {
			if (best[start] === Number.POSITIVE_INFINITY) continue
			if (start > 0 && facts[start - 1]!.glued) continue
			const candidate = best[start]! + cost(start, to, to === count)
			if (candidate < best[to]!) {
				best[to] = candidate
				from[to] = start
			}
			// Stop widening once even an empty-penalty line would exceed the ceiling.
			if (lineWidth(start, to) > limits.max && to - start > 1) break
		}
	}
	const breaks: number[] = []
	for (let at = count; at > 0; at = from[at]!) breaks.unshift(from[at]!)
	return breaks
}

/**
 * Cut prose into sentences, at a terminator followed by something that opens one.
 *
 * Tokenizing first is what makes this safe: a code span, a link and a `{@link}` are
 * single tokens, so a period inside one is never a boundary.
 * A terminator inside parentheses is not one either — an aside carries its own full stop
 * and the sentence continues past the closing bracket.
 */
export function splitSentences(text: string): string[] {
	const tokens = words(text)
	if (!tokens) return [text]
	const sentences: string[] = []
	let current: string[] = []
	let depth = 0
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!
		current.push(token)
		for (const character of token) {
			if (character === "(" || character === "[") depth++
			else if (character === ")" || character === "]") depth = Math.max(0, depth - 1)
		}
		const next = tokens[i + 1]
		if (next === undefined || depth > 0) continue
		if (!/[.!?][)"'\]`]*$/.test(token) || ABBREVIATIONS.test(token)) continue
		if (!/^[A-Z`"([]/.test(next)) continue
		sentences.push(current.join(" "))
		current = []
	}
	if (current.length) sentences.push(current.join(" "))
	return sentences
}

/**
 * Group a paragraph's sentences into the paragraphs it should have become.
 *
 * The lead sentence stands alone: it says what the thing is, and everything after it qualifies that.
 * The rest travel in pairs, which is the density the hand-written comments in
 * this codebase's ancestor settled on.
 */
function groupSentences(sentences: readonly string[], perParagraph: number, leadAlone: boolean): string[][] {
	if (sentences.length < 2) return [sentences.slice()]
	const groups: string[][] = []
	let rest = sentences.slice()
	if (leadAlone) {
		groups.push([rest[0]!])
		rest = rest.slice(1)
	}
	for (let i = 0; i < rest.length; i += perParagraph) groups.push(rest.slice(i, i + perParagraph))
	const last = groups.at(-1)
	// A short sentence left over on its own is a stranded paragraph, which reads worse than a paragraph of three.
	if (groups.length > 1 && last && last.length === 1 && last[0]!.length < weights.orphanParagraph) {
		groups.at(-2)!.push(...groups.pop()!)
	}
	return groups
}

/** Set a run of prose, one sentence per line, each sentence broken by `chooseBreaks` when it must be. */
function wrapProse(text: string, limits: WrapLimits, first = "", continuation = "") {
	const sentences = splitSentences(text)
	// A tag with no description has no sentences, and its prefix is the whole line — `@deprecated` on its own.
	if (!sentences.length) return wrap(text, limits, first, continuation)
	const lines: string[] = []
	for (const [index, sentence] of sentences.entries()) {
		const wrapped = wrap(sentence, limits, index === 0 ? first : continuation, continuation)
		if (!wrapped) return undefined
		lines.push(...wrapped)
	}
	return lines
}

function wrap(text: string, limits: WrapLimits, first = "", continuation = "") {
	const tokens = words(text)
	if (!tokens) return undefined
	if (tokens.length === 0) return [first.trimEnd()]
	const firstWidth = columns(first, limits.tabWidth)
	const continuationWidth = columns(continuation, limits.tabWidth)
	const starts = chooseBreaks(tokens, limits, firstWidth, continuationWidth)
	const lines: string[] = []
	for (let i = 0; i < starts.length; i++) {
		const begin = starts[i]!
		const end = i + 1 < starts.length ? starts[i + 1]! : tokens.length
		const body = tokens.slice(begin, end).join(" ")
		lines.push(((begin === 0 ? first : continuation) + body).trimEnd())
	}
	return lines
}

function tagParts(line: string): { prefix: string; description: string } | undefined {
	const match =
		/^@(param|arg|argument|property|prop|returns?|throws?|exception|description|desc|summary|remarks|deprecated)\b\s*/.exec(
			line
		)
	if (!match) return undefined
	let end = match[0].length
	if (line[end] === "{") {
		const typeEnd = balancedEnd(line, end, "{", "}", true)
		if (!typeEnd) return undefined
		end = typeEnd
		while (line[end] === " " || line[end] === "\t") end++
	}
	if (/^(param|arg|argument|property|prop)$/.test(match[1]!)) {
		if (line[end] === "[") {
			const nameEnd = balancedEnd(line, end, "[", "]", true)
			if (!nameEnd) return undefined
			end = nameEnd
		} else {
			const name = /^[\w.$]+/.exec(line.slice(end))
			if (!name) return undefined
			end += name[0].length
		}
		while (line[end] === " " || line[end] === "\t") end++
	}
	if (line.slice(end, end + 2) === "- ") end += 2
	const prefix = line.slice(0, end)
	return { prefix: /\s$/.test(prefix) ? prefix : prefix + " ", description: line.slice(end) }
}

function isStructure(line: string) {
	return (
		/^\s*https?:\/\/\S+\s*$/i.test(line) ||
		/^(?:\s{4}|\t|\s*[*+-]\s|\s*\d+[.)]\s|\s*[#>|]|\s*\[[^\]]+\]:|\s*(?:---+|===+)\s*$|\s*`{3}|\s*~{3}|\s*@)/.test(
			line
		) ||
		// Keep HTML-only lines and unfinished tags, but allow a tag before prose.
		/^\s*<(?:[!?]|[^>]*$|.*>\s*$)/.test(line) ||
		/(?: {2}|\\)$/.test(line) ||
		/^\s*type\s+[\w$]+(?:\s*<.*>)?\s*=/.test(line) ||
		// `{@link …}` opens a description rather than an object literal, so the brace test excludes an inline tag.
		/^\s*(?:const |let |var |function |class |import |export |return |if\s*\(|\/\/|\{(?!@)|\})/.test(line) ||
		/^[^{}[\]`]*\s\|\s|^[\w.$]+\(.*\)[;]?$|^[\w.$]+\s*=\s*\S/.test(line)
	)
}

/**
 * How a block's prose is divided once it has been reflowed.
 *
 * `paragraphs` is off for a run of `//` comments: a blank line there is a `//` on its own,
 * which reads as a gap in the code rather than a paragraph break.
 * Those get one sentence per line and nothing else.
 */
export interface ParagraphShape {
	paragraphs: boolean
	perParagraph: number
}

/** Reflow comment contents, with markers already removed by the caller. */
export function reflowText(
	lines: readonly string[],
	limits: WrapLimits,
	jsdoc = false,
	shape: ParagraphShape = { paragraphs: false, perParagraph: defaultOptions.paragraphSentences }
): string[] {
	const output: string[] = []
	let fence: { marker: string; length: number } | undefined
	let opaqueTag = false
	// The block's opening paragraph is the one whose lead sentence stands alone.
	let leadPending = true
	for (let i = 0; i < lines.length;) {
		const line = lines[i]!
		const fenceMatch = /^\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})/.exec(line)
		if (fence) {
			output.push(line)
			if (
				fenceMatch &&
				fenceMatch[1]![0] === fence.marker &&
				fenceMatch[1]!.length >= fence.length &&
				line.trim() === fenceMatch[1]
			)
				fence = undefined
			i++
			continue
		}
		if (fenceMatch) {
			fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
			output.push(line)
			i++
			continue
		}
		if (jsdoc && /^@\S/.test(line)) {
			const parts = tagParts(line)
			opaqueTag = !parts
			if (parts) {
				let end = i + 1
				while (end < lines.length && lines[end]!.trim() && !lines[end]!.startsWith("@") && !isStructure(lines[end]!))
					end++
				const text = [parts.description, ...lines.slice(i + 1, end).map((value) => value.trim())].join(" ")
				const completeMarkup = [parts.description, ...lines.slice(i + 1, end)].every(
					(value) => words(value) !== undefined
				)
				output.push(
					...((completeMarkup ? wrapProse(text, limits, parts.prefix, "  ") : undefined) ?? lines.slice(i, end))
				)
				leadPending = false
				i = end
				continue
			}
		}
		if (opaqueTag || !line.trim()) {
			output.push(line)
			i++
			continue
		}
		const list = /^( {0,3}(?:[-+*]|\d+[.)])\s+)(.*)/.exec(line)
		if (list && !/(?: {2}|\\)$/.test(line)) {
			const prefix = list[1]!
			const continuation = " ".repeat(prefix.length)
			let end = i + 1
			while (
				end < lines.length &&
				lines[end]!.startsWith(continuation) &&
				lines[end]!.trim() &&
				!isStructure(lines[end]!.slice(continuation.length))
			)
				end++
			const text = [list[2]!, ...lines.slice(i + 1, end).map((value) => value.trim())].join(" ")
			const completeMarkup = [list[2]!, ...lines.slice(i + 1, end)].every((value) => words(value) !== undefined)
			output.push(
				...((completeMarkup ? wrapProse(text, limits, prefix, continuation) : undefined) ?? lines.slice(i, end))
			)
			leadPending = false
			i = end
			continue
		}
		if (isStructure(line)) {
			output.push(line)
			i++
			continue
		}
		const indent = /^ */.exec(line)![0]
		let end = i + 1
		while (
			end < lines.length &&
			lines[end]!.trim() &&
			!isStructure(lines[end]!) &&
			/^ */.exec(lines[end]!)![0] === indent
		)
			end++
		const text = lines
			.slice(i, end)
			.map((value) => value.trim())
			.join(" ")
		const completeInlineMarkup = lines.slice(i, end).every((value) => words(value) !== undefined)
		const groups = completeInlineMarkup
			? groupSentences(splitSentences(text), shape.perParagraph, shape.paragraphs && leadPending)
			: undefined
		if (groups && shape.paragraphs) {
			let written = false
			for (const group of groups) {
				const set = wrapProse(group.join(" "), limits, indent, indent)
				if (!set) {
					written = false
					break
				}
				if (written) output.push("")
				output.push(...set)
				written = true
			}
			if (written) {
				leadPending = false
				i = end
				continue
			}
		}
		output.push(
			...((completeInlineMarkup ? wrapProse(text, limits, indent, indent) : undefined) ?? lines.slice(i, end))
		)
		leadPending = false
		i = end
	}
	return output
}

/** Resolve the content-relative widths for a comment whose markers occupy `overhead` columns. */
function limitsFor(options: Required<ReflowOptions>, overhead: number): WrapLimits {
	return {
		target: Math.max(20, options.targetWidth - overhead),
		max: Math.max(24, options.printWidth - overhead),
		tabWidth: options.tabWidth,
	}
}

/**
 * A comment that says its piece in one sentence on one line within `printWidth` is left as it is.
 *
 * The measure only governs prose that has to break, so pulling a 108-column
 * one-liner onto two lines buys nothing and costs a line.
 * Two sentences on one line are a different matter: that is the shape the rule
 * exists to undo, whatever the width.
 */
function fitsOnOneLine(lines: readonly string[], overhead: number, options: Required<ReflowOptions>) {
	if (lines.filter((line) => line.trim()).length !== 1) return false
	const only = lines.find((line) => line.trim())!
	if (isStructure(only)) return false
	if (splitSentences(only.trim()).length > 1) return false
	return overhead + columns(only.trim(), options.tabWidth) <= options.printWidth
}

/**
 * Format a group of standalone line comments.
 * The first indent is external.
 */
export function reflowLineComments(
	values: readonly string[],
	indent: string,
	options: Required<ReflowOptions>,
	eol: string
): string {
	const lines = values.map((value) => (value.startsWith(" ") ? value.slice(1) : value))
	const overhead = columns(indent + "// ", options.tabWidth)
	const formatted = fitsOnOneLine(lines, overhead, options)
		? [lines.find((line) => line.trim())!.trim()]
		: reflowText(lines, limitsFor(options, overhead), false, {
				paragraphs: false,
				perParagraph: options.paragraphSentences,
			})
	return formatted.map((line) => (line ? `// ${line}` : "//")).join(eol + indent)
}

/**
 * Format an entire block token; preserve code and nonstandard block layouts. sourceLineWidth
 * includes surrounding syntax when checking a single-line block.
 */
export function reflowBlockComment(
	raw: string,
	indent: string,
	options: Required<ReflowOptions>,
	eol: string,
	sourceLineWidth = columns(indent + raw, options.tabWidth)
): string {
	if (isProtected(raw) || raw.startsWith("/*!")) return raw
	const jsdoc = raw.startsWith("/**")
	const opening = jsdoc ? "/**" : "/*"
	const body = raw.slice(opening.length, -2)
	const original = body.split(/\r\n|\n/)
	let lines: string[]
	let plainPrefix: string | undefined
	if (original.length === 1) {
		// Expanding single-line metadata or examples can change parser semantics.
		if (body.includes("@") || /`{3}|~{3}/.test(body)) return raw
		if (sourceLineWidth <= options.printWidth && splitSentences(body.trim()).length <= 1) return raw
		lines = [body.trim()]
	} else {
		if (original[0]!.trim() || original.at(-1)!.trim()) return raw
		const middle = original.slice(1, -1)
		if (middle.every((line) => /^\s*\*(?: |$)/.test(line))) {
			lines = middle.map((line) => line.replace(/^\s*\* ?/, ""))
		} else {
			if (jsdoc || middle.some((line) => /^\s*\*/.test(line))) return raw
			const indents = middle.filter((line) => line.trim()).map((line) => /^[\t ]*/.exec(line)![0])
			plainPrefix = indents.sort((a, b) => a.length - b.length)[0] ?? indent
			if (!middle.every((line) => !line.trim() || line.startsWith(plainPrefix!))) return raw
			lines = middle.map((line) => line.slice(plainPrefix!.length))
		}
	}
	const overhead = columns(plainPrefix ?? indent + " * ", options.tabWidth)
	const formatted = reflowText(lines, limitsFor(options, overhead), jsdoc, {
		// A `/* */` block whose body is indented prose keeps its own layout; only a starred block takes the shape.
		paragraphs: plainPrefix === undefined && original.length > 1,
		perParagraph: options.paragraphSentences,
	})
	if (
		original.length > 1 &&
		lines.every((line, index) => line === formatted[index]) &&
		lines.length === formatted.length
	)
		return raw
	if (plainPrefix !== undefined)
		return [opening, ...formatted.map((line) => (line ? plainPrefix + line : "")), indent + " */"].join(eol)
	return [opening, ...formatted.map((line) => indent + (line ? ` * ${line}` : " *")), indent + " */"].join(eol)
}
