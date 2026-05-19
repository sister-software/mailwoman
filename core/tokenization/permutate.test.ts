/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertDeepSerialized } from "mailwoman/sdk/test"
import { expect, test } from "vitest"
import { Span } from "./Span.js"
import { permutate } from "./permutate.js"

function selectByIndex<T>(items: Iterable<T>, ...selectedIndices: number[]): T[] {
	const indexedItems = Array.from(items)

	return selectedIndices.map((i) => {
		const item = indexedItems[i]

		if (typeof item === "undefined") {
			throw new Error(`Index ${i} is out of bounds`)
		}

		return item
	})
}

test("permutate: simple", () => {
	const span0 = Span.from("SoHo", { start: 0 })
	const span1 = Span.from("New", { start: 5 })
	const span2 = Span.from("York", { start: 9 })
	const span3 = Span.from("USA", { start: 14 })

	const spans = Span.connectSiblings(
		// ---
		span0,
		span1,
		span2,
		span3
	)

	// expected permutations
	const perm1 = Span.from("SoHo New York USA", { start: 0 })
	spans.slice(0, 4).forEach((s) => perm1.children.add(s))

	// perm1.firstChild = span0
	// perm1.lastChild = span3

	const perm2 = Span.from("SoHo New York", { start: 0 })
	spans.slice(0, 3).forEach((s) => perm2.children.add(s))

	// perm2.firstChild = span0
	// perm2.lastChild = span2

	const perm3 = Span.from("SoHo New", { start: 0 })
	spans.slice(0, 2).forEach((s) => perm3.children.add(s))

	// perm3.firstChild = span0
	// perm3.lastChild = span1

	const perm4 = Span.from("SoHo", { start: 0 })
	spans.slice(0, 1).forEach((s) => perm4.children.add(s))

	// perm4.firstChild = span0
	// perm4.lastChild = span0

	const perm5 = Span.from("New York USA", { start: 5 })
	spans.slice(1, 4).forEach((s) => perm5.children.add(s))
	// perm5.firstChild = span1
	// perm5.lastChild = span3

	const perm6 = Span.from("New York", { start: 5 })
	spans.slice(1, 3).forEach((s) => perm6.children.add(s))
	// perm6.firstChild = span1
	// perm6.lastChild = span2

	const perm7 = Span.from("New", { start: 5 })
	spans.slice(1, 2).forEach((s) => perm7.children.add(s))
	// perm7.firstChild = span1
	// perm7.lastChild = span1

	const perm8 = Span.from("York USA", { start: 9 })
	spans.slice(2, 4).forEach((s) => perm8.children.add(s))
	// perm8.firstChild = span2
	// perm8.lastChild = span3

	const perm9 = Span.from("York", { start: 9 })
	spans.slice(2, 3).forEach((s) => perm9.children.add(s))
	// perm9.firstChild = span2
	// perm9.lastChild = span2

	const perm10 = Span.from("USA", { start: 14 })
	spans.slice(3, 4).forEach((s) => perm10.children.add(s))
	// perm10.firstChild = span3
	// perm10.lastChild = span3

	const actual = permutate(spans, { from: 1, to: 6 })

	assertDeepSerialized(
		actual,
		[perm1, perm2, perm3, perm4, perm5, perm6, perm7, perm8, perm9, perm10],
		"permutations are correct"
	)
})

test("permutate: tokens contain whitespace", () => {
	const span0 = Span.from("SoHo", { start: 0 })
	const span1 = Span.from("New York", { start: 5 })
	const span2 = Span.from("USA", { start: 14 })

	const spans = Span.connectSiblings(
		// ---
		span0,
		span1,
		span2
	)

	// expected permutations
	const perm1 = Span.from("SoHo New York USA", { start: 0 })
	spans.slice(0, 3).forEach((s) => perm1.children.add(s))

	// perm1.firstChild = span0
	// perm1.lastChild = span2

	const perm2 = Span.from("SoHo New York", { start: 0 })
	spans.slice(0, 2).forEach((s) => perm2.children.add(s))

	// perm2.firstChild = span0
	// perm2.lastChild = span1

	const perm3 = Span.from("SoHo", { start: 0 })
	spans.slice(0, 1).forEach((s) => perm3.children.add(s))

	// perm3.firstChild = span0
	// perm3.lastChild = span0

	const perm4 = Span.from("New York USA", { start: 5 })
	spans.slice(1, 3).forEach((s) => perm4.children.add(s))
	// perm4.firstChild = span1
	// perm4.lastChild = span2

	const perm5 = Span.from("New York", { start: 5 })
	spans.slice(1, 2).forEach((s) => perm5.children.add(s))
	// perm5.firstChild = span1
	// perm5.lastChild = span1

	const perm6 = Span.from("USA", { start: 14 })
	spans.slice(2, 3).forEach((s) => perm6.children.add(s))
	// perm6.firstChild = span2
	// perm6.lastChild = span2

	const actual = permutate(spans, { from: 1, to: 6 })
	assertDeepSerialized(actual, [perm1, perm2, perm3, perm4, perm5, perm6])
})

test("permutate: smaller window", () => {
	const span0 = Span.from("SoHo", { start: 0 })
	const span1 = Span.from("New", { start: 5 })
	const span2 = Span.from("York", { start: 9 })
	const span3 = Span.from("USA", { start: 13 })

	const spans = Span.connectSiblings(
		// ---
		span0,
		span1,
		span2,
		span3
	)

	// expected permutations
	const perm1 = Span.from("SoHo New", { start: 0 })
	spans.slice(0, 2).forEach((s) => perm1.children.add(s))

	// perm1.firstChild = span0
	// perm1.lastChild = span1

	const perm2 = Span.from("SoHo", { start: 0 })
	spans.slice(0, 1).forEach((s) => perm2.children.add(s))

	// perm2.firstChild = span0
	// perm2.lastChild = span0

	const perm3 = Span.from("New York", { start: 5 })
	spans.slice(1, 3).forEach((s) => perm3.children.add(s))
	// perm3.firstChild = span1
	// perm3.lastChild = span2

	const perm4 = Span.from("New", { start: 5 })
	spans.slice(1, 2).forEach((s) => perm4.children.add(s))
	// perm4.firstChild = span1
	// perm4.lastChild = span1

	const perm5 = Span.from("York USA", { start: 9 })
	spans.slice(2, 4).forEach((s) => perm5.children.add(s))
	// perm5.firstChild = span2
	// perm5.lastChild = span3

	const perm6 = Span.from("York", { start: 9 })
	spans.slice(2, 3).forEach((s) => perm6.children.add(s))
	// perm6.firstChild = span2
	// perm6.lastChild = span2

	const perm7 = Span.from("USA", { start: 13 })
	spans.slice(3, 4).forEach((s) => perm7.children.add(s))
	// perm7.firstChild = span3
	// perm7.lastChild = span3

	const actual = permutate(spans, { from: 1, to: 2 })
	assertDeepSerialized(actual, [perm1, perm2, perm3, perm4, perm5, perm6, perm7])
})

test("permutate: start/end values", () => {
	// "  SoHo     New  York  "

	const span0 = Span.from("SoHo", { start: 2 })
	span0.end = 6

	const span1 = Span.from("New", { start: 11 })
	span1.end = 14

	const span2 = Span.from("York", { start: 15 })
	span2.end = 19

	const spans = Span.connectSiblings(span0, span1, span2)

	// expected permutations
	const perm1 = Span.from("SoHo New York", { start: 2 })
	perm1.start = span0.start
	perm1.end = span2.end
	spans.slice(0, 3).forEach((s) => perm1.children.add(s))

	// perm1.firstChild = span0
	// perm1.lastChild = span1

	const perm2 = Span.from("SoHo New", { start: 2 })
	perm2.start = span0.start
	perm2.end = span1.end
	spans.slice(0, 2).forEach((s) => perm2.children.add(s))

	// perm2.firstChild = span0
	// perm2.lastChild = span0

	const perm3 = Span.from("SoHo", { start: 2 })
	perm3.start = span0.start
	perm3.end = span0.end
	spans.slice(0, 1).forEach((s) => perm3.children.add(s))

	// perm3.firstChild = span0
	// perm3.lastChild = span0

	const perm4 = Span.from("New York", { start: 11 })
	perm4.start = span1.start
	perm4.end = span2.end
	spans.slice(1, 3).forEach((s) => perm4.children.add(s))
	// perm4.firstChild = span0
	// perm4.lastChild = span1

	const perm5 = Span.from("New", { start: 11 })
	perm5.start = span1.start
	perm5.end = span1.end
	spans.slice(1, 2).forEach((s) => perm5.children.add(s))
	// perm5.firstChild = span0
	// perm5.lastChild = span0

	const perm6 = Span.from("York", { start: 15 })
	perm6.start = span2.start
	perm6.end = span2.end

	spans.slice(2, 3).forEach((s) => perm6.children.add(s))
	// perm6.firstChild = span1
	// perm6.lastChild = span1

	const actual = permutate(spans, { from: 1, to: 6 })
	assertDeepSerialized(actual, [perm1, perm2, perm3, perm4, perm5, perm6])
})

test("permutate: relationships", () => {
	const span1 = Span.from("SoHo", { start: 0 })
	const span2 = Span.from("New", { start: 5 })
	const span3 = Span.from("York", { start: 14 })
	const spans = Span.connectSiblings(span1, span2, span3)

	const actual = permutate(spans, { from: 1, to: 6 })

	// Soho New York
	const permutation1 = actual[0]!

	expect(permutation1.children.has(span1), "perm1 contains span1").toBe(true)
	expect(span1.parents.has(permutation1), "span1 parent is perm1").toBe(true)

	expect(permutation1.children.has(span2), "perm1 contains span2").toBe(true)
	expect(span2.parents.has(permutation1), "span2 parent is perm1").toBe(true)
	expect(permutation1.children.has(span3), "perm1 contains span3").toBe(true)
	expect(span3.parents.has(permutation1), "span3 parent is perm1").toBe(true)

	// Soho New
	const perm2 = actual[1]!

	expect(perm2.children.has(span1)).toBe(true)
	expect(span1.parents.has(perm2), "span1 parent is perm2").toBe(true)
	expect(perm2.children.has(span2), "perm2 contains span2").toBe(true)
	expect(span2.parents.has(perm2), "span2 parent is perm2").toBe(true)

	// Soho
	const perm3 = actual[2]!
	expect(perm3.children.has(span1)).toBe(true)
	expect(span1.parents.has(perm3), "span1 parent is perm3").toBe(true)

	// New York
	const perm4 = actual[3]!
	expect(perm4.children.has(span2)).toBe(true)
	expect(span2.parents.has(perm4), "span2 parent is perm4").toBe(true)
	expect(perm4.children.has(span3)).toBe(true)
	expect(span3.parents.has(perm4), "span3 parent is perm4").toBe(true)

	// New
	const perm5 = actual[4]!
	expect(perm5.children.has(span2), "perm5 contains span2").toBe(true)
	expect(span2.parents.has(perm5), "span2 parent is perm5").toBe(true)

	// York
	const perm6 = actual[5]!
	expect(perm6.children.has(span3), "perm6 contains span3").toBe(true)
	expect(span3.parents.has(perm6), "span3 parent is perm6").toBe(true)
})

test("permutate: with hyphen", () => {
	const span1 = Span.from("SoHo", { start: 0 })
	const span2 = Span.from("New-York", { start: 5 })
	const span3 = Span.from("USA", { start: 14 })

	const span4 = Span.from("New", { start: 5 })
	const span5 = Span.from("York", { start: 9 })

	const spans = Span.connectSiblings(
		// ---
		span1,
		span2,
		span3
	)

	spans.push(span4, span5)

	// SoHo -> New
	span1.nextSiblings.add(span4)
	// New -> York
	span4.nextSiblings.add(span5)
	// York -> USA
	span5.nextSiblings.add(span3)

	// expected permutations
	const perm1 = Span.from("SoHo New-York USA", { start: 0 })
	spans.slice(0, 3).forEach((s) => perm1.children.add(s))

	// perm1.firstChild = span1
	// perm1.lastChild = span3

	const perm2 = Span.from("SoHo New-York", { start: 0 })
	spans.slice(0, 2).forEach((s) => perm2.children.add(s))

	// perm2.firstChild = span1
	// perm2.lastChild = span2

	const perm3 = Span.from("SoHo New York USA", { start: 0 })
	selectByIndex(spans, 0, 3, 4, 2).forEach((s) => perm3.children.add(s))
	// perm3.firstChild = span1
	// perm3.lastChild = span3

	const perm4 = Span.from("SoHo New York", { start: 0 })
	selectByIndex(spans, 0, 3, 4).forEach((s) => perm4.children.add(s))
	// perm4.firstChild = span1
	// perm4.lastChild = span5

	const perm5 = Span.from("SoHo New", { start: 0 })
	selectByIndex(spans, 0, 3).forEach((s) => perm5.children.add(s))
	// perm5.firstChild = span1
	// perm5.lastChild = span4

	const perm6 = Span.from("SoHo", { start: 0 })
	spans.slice(0, 1).forEach((s) => perm6.children.add(s))

	// perm6.firstChild = span1
	// perm6.lastChild = span1

	const perm7 = Span.from("New-York USA", { start: 5 })
	spans.slice(1, 3).forEach((s) => perm7.children.add(s))
	// perm7.firstChild = span2
	// perm7.lastChild = span3

	const perm8 = Span.from("New-York", { start: 5 })
	spans.slice(1, 2).forEach((s) => perm8.children.add(s))
	// perm8.firstChild = span2
	// perm8.lastChild = span2

	const perm9 = Span.from("USA", { start: 14 })
	spans.slice(2, 3).forEach((s) => perm9.children.add(s))
	// perm9.firstChild = span3
	// perm9.lastChild = span3

	const perm10 = Span.from("New York USA", { start: 5 })

	selectByIndex(spans, 3, 4, 2).forEach((s) => perm10.children.add(s))
	// perm10.firstChild = span4
	// perm10.lastChild = span3

	const perm11 = Span.from("New York", { start: 5 })
	selectByIndex(spans, 3, 4).forEach((s) => perm11.children.add(s))
	// perm11.firstChild = span4
	// perm11.lastChild = span5

	const perm12 = Span.from("New", { start: 5 })
	spans.slice(3, 4).forEach((s) => perm12.children.add(s))
	// perm12.firstChild = span4
	// perm12.lastChild = span4

	const perm13 = Span.from("York USA", { start: 9 })
	selectByIndex(spans, 4, 2).forEach((s) => perm13.children.add(s))
	// perm13.firstChild = span5
	// perm13.lastChild = span3

	const perm14 = Span.from("York", { start: 9 })
	spans.slice(4, 5).forEach((s) => perm14.children.add(s))
	// perm14.firstChild = span5
	// perm14.lastChild = span5

	const actual = permutate(spans, { from: 1, to: 10 })

	assertDeepSerialized(actual, [
		perm1,
		perm2,
		perm3,
		perm4,
		perm5,
		perm6,
		perm7,
		perm8,
		perm9,
		perm10,
		perm11,
		perm12,
		perm13,
		perm14,
	])
})
