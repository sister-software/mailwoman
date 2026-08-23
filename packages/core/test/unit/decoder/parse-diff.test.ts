/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `diffParse` — telling the four span events apart.
 *
 *   Every test here is a case a COMPONENT-MAP diff reports identically, which is why this file exists. The worked
 *   example is real: v4.8.0 turned `Ye Three Lords, 27 Minories, London EC3N 1DE` from
 *   `venue "Ye Three Lords" · locality London · street Minories` into `locality "Ye Three Lords"`. Keyed by tag that
 *   reads as "the locality changed"; what happened is that two spans were destroyed and a third was retagged onto the
 *   text of one of them.
 */

import { diffParse, isChange, renderParseDiff } from "@mailwoman/core/decoder/parse-diff"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder/types"
import { describe, expect, it } from "vitest"

/**
 * Build a tree from flat spans. The diff reads through `flattenTreeNodes`, so roots are enough.
 */
function tree(...nodes: Array<[string, string, number, number, number, string?]>): AddressTree {
	return {
		roots: nodes.map(([tag, value, start, end, confidence, source]) => {
			const node = { tag, value, start, end, confidence, children: [] } as unknown as AddressNode

			if (source) {
				;(node as { source?: string }).source = source
			}

			return node
		}),
	} as unknown as AddressTree
}

const INPUT = "Ye Three Lords, 27 Minories, London EC3N 1DE"

describe("diffParse", () => {
	it("separates a RETAG from a removal — the Ye Three Lords regression", () => {
		const before = tree(
			["venue", "Ye Three Lords", 0, 14, 0.91],
			["house_number", "27", 16, 18, 0.99],
			["street", "Minories", 19, 27, 0.88],
			["locality", "London", 29, 35, 0.95]
		)

		const after = tree(["locality", "Ye Three Lords", 0, 14, 0.62], ["house_number", "27", 16, 18, 0.99])

		const diff = diffParse(INPUT, before, after)
		const changed = diff.spans.filter(isChange)

		// The venue was RETAGGED onto its own text, not deleted — a tag-keyed diff cannot say this.
		const retag = changed.find((s) => s.kind === "retagged")

		expect(retag?.tagBefore).toBe("venue")
		expect(retag?.tagAfter).toBe("locality")
		expect(retag?.valueAfter).toBe("Ye Three Lords")
		// And it got much less sure while doing it, which is the tell that it was a coin-flip.
		expect(retag?.confidenceDelta).toBeCloseTo(-0.29, 2)

		// The street and the real locality were genuinely destroyed.
		expect(
			changed
				.filter((s) => s.kind === "removed")
				.map((s) => s.tagBefore)
				.toSorted()
		).toEqual(["locality", "street"])
	})

	it("calls a boundary slide a MOVE, not a delete plus an insert", () => {
		// `Green Point, Cape Town` -> the locality slides one segment left. Equality-keyed matching reports this as two
		// events and loses the fact that it is one span shifting.
		const before = tree(["locality", "Cape Town", 20, 29, 0.9])
		const after = tree(["locality", "Cape Town, 8001", 20, 35, 0.7])

		const changed = diffParse("14 Long St, Green Point, Cape Town, 8001", before, after).spans.filter(isChange)

		expect(changed).toHaveLength(1)
		expect(changed[0]?.kind).toBe("moved")
		expect(changed[0]?.spanBefore).toEqual([20, 29])
		expect(changed[0]?.spanAfter).toEqual([20, 35])
	})

	it("reports a same-answer confidence slide, because that row is about to flip", () => {
		const before = tree(["locality", "London", 29, 35, 0.95])
		const after = tree(["locality", "London", 29, 35, 0.58])

		const changed = diffParse(INPUT, before, after).spans.filter(isChange)

		expect(changed).toHaveLength(1)
		expect(changed[0]?.kind).toBe("confidence")
		expect(changed[0]?.confidenceDelta).toBeCloseTo(-0.37, 2)
	})

	it("does not relate two spans that merely touch at the edges", () => {
		// Below the overlap floor these are unrelated, and calling it a `moved` would invent a relationship the parse
		// never asserted.
		const before = tree(["street", "Minories", 19, 27, 0.9])
		const after = tree(["locality", "London", 29, 35, 0.9])

		const kinds = diffParse(INPUT, before, after)
			.spans.filter(isChange)
			.map((s) => s.kind)
			.toSorted()

		expect(kinds).toEqual(["added", "removed"])
	})

	it("surfaces a span that kept its tag but LOST its resolver backing", () => {
		// Same tag, same text, same span — and it stopped being gazetteer-backed. No tag-level diff can show this.
		const before = tree(["locality", "London", 29, 35, 0.95, "resolver"])
		const after = tree(["locality", "London", 29, 35, 0.95, "neural"])

		const diff = diffParse(INPUT, before, after)
		const span = diff.spans.find((s) => s.tagAfter === "locality")

		expect(span?.sourceBefore).toBe("resolver")
		expect(span?.sourceAfter).toBe("neural")
	})

	it("reports a locale-country move even when every span is identical", () => {
		// A parse that changed nothing else but moved its country confidence across the scope threshold geocodes
		// somewhere else entirely.
		const same = tree(["locality", "London", 29, 35, 0.95])

		const diff = diffParse(INPUT, same, same, {
			before: { country: "GB", confidence: 0.97 },
			after: { country: "US", confidence: 0.51 },
		})

		expect(diff.identical).toBe(false)
		expect(renderParseDiff(diff)).toContain("locale country GB (0.97) → US (0.51)")
	})

	it("says so plainly when the arms agree", () => {
		const same = tree(["locality", "London", 29, 35, 0.95])

		expect(diffParse(INPUT, same, same).identical).toBe(true)
		expect(renderParseDiff(diffParse(INPUT, same, same))).toContain("(identical)")
	})

	it("renders the ADDRESS first, then what moved under it", () => {
		const before = tree(["venue", "Ye Three Lords", 0, 14, 0.91], ["street", "Minories", 19, 27, 0.88])
		const after = tree(["locality", "Ye Three Lords", 0, 14, 0.62])

		const out = renderParseDiff(diffParse(INPUT, before, after))
		// A rendered diff is a handful of lines about one address.
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and in-memory already
		const lines = out.split("\n")

		// An aggregate that reports a count without the string is the shape that let a venue-destroying regression read
		// as routine for five runs.
		expect(lines[0]).toBe(INPUT)
		expect(out).toContain("venue → locality")
		expect(out).toContain('- street="Minories"')
	})
})
