/**
 * @copyright Sister Software
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
): void {
	// Stops when the window is reached
	if (windowCur > windowMax) return

	// Create new span base on the previous and the next one
	const span = new Span(prevSpan.body + (prevSpan.body.length > 0 ? JOIN_CHAR : "") + currentSpan.body, prevSpan.start)

	// Add all children from the previous span to the new one, they will have the same ones + the next one
	// Add to all children from the previous span the new span as parent + the next one
	prevSpan.children.forEach((child) => {
		span.children.add(child)
		child.parents.add(span)
	})

	span.children.add(currentSpan)
	currentSpan.parents.add(span)

	const isFirst = span.body === currentSpan.body
	const isLast = !currentSpan.nextSibling

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
		currentSpan.nextSiblings.forEach((next) => {
			permutateRec(span, next, windowCur + 1, windowMin, windowMax, permutations)
		})
	}

	if (windowMin <= windowCur) {
		permutations.push(span)
	}
}

export interface PermutateOptions {
	/**
	 * The minimum amount of tokens which can be returned in a single window.
	 */
	from: number

	/**
	 * The maximum amount of tokens which can be returned in a single window.
	 */
	to: number
}

/**
 * Produce all the possible token groups from adjacent input tokens (without reordering tokens).
 *
 * Example: ['soho', 'new', 'york', 'usa'] [ ['soho', 'new', 'york', 'usa'], ['soho', 'new',
 * 'york'], ['soho', 'new'], ['soho'], ['new', 'york', 'usa'], ['new', 'york'], ['new'], ['york',
 * 'usa'], ['york'], ['usa'], ]
 *
 * @param spans - The spans to permutate
 *
 * @returns The permutations
 */
export function permutate(spans: Iterable<Span>, { from, to }: PermutateOptions): Span[] {
	const permutations: Span[] = []

	for (const span of spans) {
		permutateRec(new Span(), span, 1, from, to, permutations)
	}

	return permutations
}
