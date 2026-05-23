/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { classifyToken, foldInputClass, tokenizeForClass } from "./character-class.js"
import { detectKnownFormats } from "./known-formats.js"
import { segment } from "./segmentation.js"
import type { ComputeQueryShapeOpts, NormalizedInputLite, QueryShape, TokenClass, WhitespacePattern } from "./types.js"

function detectWhitespacePattern(text: string): WhitespacePattern {
	let hasTab = false
	let hasDouble = false
	let hasSingle = false
	let prevSpace = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === "\t") {
			hasTab = true
		} else if (ch === " ") {
			if (prevSpace) hasDouble = true
			else hasSingle = true
			prevSpace = true
			continue
		}
		prevSpace = false
	}
	if (hasTab && (hasDouble || hasSingle)) return "mixed"
	if (hasTab) return "tab"
	if (hasDouble) return "double"
	if (hasSingle) return "single"
	return "none"
}

/**
 * Compute a `QueryShape` from a string or normalized input. Microseconds-cheap, pure-function.
 *
 * @example Const shape = computeQueryShape("350 5th Ave, New York, NY 10118") //
 * shape.knownFormats.find((f) => f.format === "us_zip") → defined // shape.segments.length === 4
 */
export function computeQueryShape(input: string | NormalizedInputLite, opts?: ComputeQueryShapeOpts): QueryShape {
	const text = typeof input === "string" ? input : input.normalized
	const locale = opts?.locale ?? (typeof input === "string" ? undefined : input.appliedLocale)

	const tokenSpans = tokenizeForClass(text)
	const tokenClasses: TokenClass[] = tokenSpans.map((span) => ({
		span,
		class: classifyToken(span.body),
		length: span.end - span.start,
	}))

	const segments = segment(text, locale)
	const knownFormats = detectKnownFormats(text, tokenClasses)
	const characterClass = foldInputClass(tokenClasses)
	const whitespacePattern = detectWhitespacePattern(text)

	return Object.freeze({
		characterClass,
		tokenClasses: Object.freeze(tokenClasses) as TokenClass[],
		segments: Object.freeze(segments) as typeof segments,
		knownFormats: Object.freeze(knownFormats) as typeof knownFormats,
		totalLength: text.length,
		whitespacePattern,
	}) satisfies QueryShape
}
