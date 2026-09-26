/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `diffParse` — telling the four span events apart.
 *
 *   Every case here is one a component-map diff reports identically: keyed by tag, `venue "Ye Three Lords" · locality London · street Minories` becoming `locality "Ye Three Lords"` reads as "the locality changed" when two spans were destroyed and a third was retagged onto the text of one.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { diffParse, isChange, renderParseDiff } from "@mailwoman/core/decoder/parse-diff"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder/types"
import { describe, expect, it } from "vitest"

/**
 * The diff reads through `flattenTreeNodes`, so roots are enough.
 */
function tree(...nodes: Array<[string, string, number, number, number, string?]>): AddressTree {
	return {
		raw: INPUT,
		roots: nodes.map(([tag, value, start, end, confidence, source]): AddressNode => {
			const node: AddressNode = { tag: tag as ComponentTag, value, start, end, confidence, children: [] }

			if (source) {
				node.source = source
			}

			return node
		}),
	}
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

		// The venue was retagged onto its own text rather than deleted, which a tag-keyed diff cannot say.
		const retag = changed.find((s) => s.kind === "retagged")

		expect(retag?.tagBefore).toBe("venue")
		expect(retag?.tagAfter).toBe("locality")
		expect(retag?.valueAfter).toBe("Ye Three Lords")
		expect(retag?.confidenceDelta).toBeCloseTo(-0.29, 2)

		expect(
			changed
				.filter((s) => s.kind === "removed")
				.map((s) => s.tagBefore)
				.toSorted()
		).toEqual(["locality", "street"])
	})

	it("calls a boundary slide a MOVE, not a delete plus an insert", () => {
		// `Green Point, Cape Town` slides the locality one segment left, which equality-keyed
		// matching reports as two events, losing that one span shifted.
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
		// Below the overlap floor these are unrelated, and calling it a `moved` would
		// invent a relationship the parse never asserted.
		const before = tree(["street", "Minories", 19, 27, 0.9])
		const after = tree(["locality", "London", 29, 35, 0.9])

		const kinds = diffParse(INPUT, before, after)
			.spans.filter(isChange)
			.map((s) => s.kind)
			.toSorted()

		expect(kinds).toEqual(["added", "removed"])
	})

	it("surfaces a span that kept its tag but LOST its resolver backing", () => {
		// Same tag, same text, same span, but it stopped being gazetteer-backed, which no tag-level diff can show.
		const before = tree(["locality", "London", 29, 35, 0.95, "resolver"])
		const after = tree(["locality", "London", 29, 35, 0.95, "neural"])

		const diff = diffParse(INPUT, before, after)
		const span = diff.spans.find((s) => s.tagAfter === "locality")

		expect(span?.sourceBefore).toBe("resolver")
		expect(span?.sourceAfter).toBe("neural")
	})

	it("reports a locale-country move even when every span is identical", () => {
		// A parse that changed no component but moved its country confidence across the
		// scope threshold geocodes somewhere else entirely.
		const same = tree(["locality", "London", 29, 35, 0.95])

		const diff = diffParse(INPUT, same, same, {
			before: { country: "GB", confidence: 0.97 },
			after: { country: "US", confidence: 0.51 },
		})

		expect(diff.identical).toBe(false)
		expect(renderParseDiff(diff)).toContain("locale country GB (0.97) → US (0.51)")
	})

	it("states when the arms agree", () => {
		const same = tree(["locality", "London", 29, 35, 0.95])

		expect(diffParse(INPUT, same, same).identical).toBe(true)
		expect(renderParseDiff(diffParse(INPUT, same, same))).toContain("(identical)")
	})

	it("renders the ADDRESS first, then what moved under it", () => {
		const before = tree(["venue", "Ye Three Lords", 0, 14, 0.91], ["street", "Minories", 19, 27, 0.88])
		const after = tree(["locality", "Ye Three Lords", 0, 14, 0.62])

		const out = renderParseDiff(diffParse(INPUT, before, after))
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and in-memory already
		const lines = out.split("\n")

		expect(lines[0]).toBe(INPUT)
		expect(out).toContain("venue → locality")
		expect(out).toContain('- street="Minories"')
	})
})
