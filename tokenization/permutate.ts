/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "./Span.js"

const JOIN_CHAR = " "

/**
 * Produce all the possible token groups from adjacent input tokens (without reordering tokens)
 *
 * WindowMin: the minimum amount of tokens which can be returned in a single window windowMax: the
 * maximum amount of tokens which can be returned in a single window
 *
 * Note: we should honor word boundary delimiters (such as comma) when creating permutations ported:
 * https://github.com/pelias/placeholder/blob/master/lib/permutations.js
 */
function permutateRec(
	prevSpan: Span,
	currentSpan: Span,
	windowCur: number,
	windowMin: number,
	windowMax: number,
	permutations: Span[]
) {
	// Stops when the window is reached
	if (windowCur > windowMax) {
		return
	}
	// Create new span base on the previous and the next one
	const span = new Span(prevSpan.body + (prevSpan.body.length > 0 ? JOIN_CHAR : "") + currentSpan.body, prevSpan.start)
	// Add all children from the previous span to the new one, they will have the same ones + the next one
	// Add to all children from the previous span the new span as parent + the next one
	prevSpan.graph.findAll("child").forEach((child) => {
		span.graph.add("child", child)
		child.graph.add("parent", span)
	})
	span.graph.add("child", currentSpan)
	currentSpan.graph.add("parent", span)

	const isFirst = span.body === currentSpan.body
	const isLast = !currentSpan.graph.findOne("next")

	// If span is the first one, s is the first child, otherwise we take the first child of the previous span
	if (isFirst) {
		span.graph.add("child:first", currentSpan)
	} else {
		span.graph.add("child:first", prevSpan.graph.findOne("child:first")!)
	}

	span.graph.add("child:last", currentSpan)

	if (isFirst) {
		span.start = currentSpan.start
		span.end = currentSpan.end
	} else {
		if (currentSpan.start < span.start) {
			span.start = currentSpan.start
		}
		if (currentSpan.end > span.end) {
			span.end = currentSpan.end
		}
	}

	// go through the graph recursively, check all next spans
	if (!isLast) {
		currentSpan.graph.findAll("next").forEach((next) => {
			permutateRec(span, next, windowCur + 1, windowMin, windowMax, permutations)
		})
	}

	if (windowMin <= windowCur) {
		permutations.push(span)
	}
}

/**
 * Produce all the possible token groups from adjacent input tokens (without reordering tokens).
 *
 * Example: ['soho', 'new', 'york', 'usa'] [ ['soho', 'new', 'york', 'usa'], ['soho', 'new',
 * 'york'], ['soho', 'new'], ['soho'], ['new', 'york', 'usa'], ['new', 'york'], ['new'], ['york',
 * 'usa'], ['york'], ['usa'], ]
 */
export function permutate(spans: Span[], windowMin: number, windowMax: number): Span[] {
	const permutations: Span[] = []

	spans.forEach((span) => {
		permutateRec(new Span(), span, 1, windowMin, windowMax, permutations)
	})
	return permutations
}
