import type { ComponentTag } from "@mailwoman/codex/component"
import { decodeAsJSON } from "@mailwoman/core/decoder/serialize-json"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder/types"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opt-in `dropped` surface, which reports spans the flat projection could not represent.
 *
 *   `decodeAsJSON` holds one value per tag, so a tree carrying two `locality` spans emits one and
 *   drops the other. Without a report, `region: null` means both that the input carried no region
 *   and that it carried one which was dropped.
 */
import { describe, expect, it } from "vitest"

function node(tag: ComponentTag, value: string, children: AddressNode[] = []): AddressNode {
	return { tag, value, start: 0, end: value.length, confidence: 1, children }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

/**
 * `country › locality "Portopetro" › postcode`, plus a second `locality` sibling.
 *
 * That sibling is a trailing region as the shipped model parses it.
 * The span exists, carries the right text, and holds the wrong tag.
 */
const TWO_LOCALITIES = tree("07691 Portopetro, Illes Balears, Spain", [
	node("country", "Spain", [
		node("locality", "Portopetro", [node("postcode", "07691")]),
		node("locality", "Illes Balears"),
	]),
])

describe("dropped spans", () => {
	it("names the span first-occurrence-wins deleted, and what held the slot", () => {
		const out = decodeAsJSON(TWO_LOCALITIES, { includeDropped: true })

		expect(out.locality).toBe("Portopetro")
		expect(out.dropped).toEqual([{ tag: "locality", value: "Illes Balears", kept: "Portopetro" }])
	})

	it("stays libpostal-flat by default — the report is opt-in", () => {
		expect("dropped" in decodeAsJSON(TWO_LOCALITIES)).toBe(false)
	})

	it("emits an EMPTY array when nothing was dropped, so absence is never ambiguous", () => {
		const clean = tree("Portopetro, Spain", [node("country", "Spain", [node("locality", "Portopetro")])])

		expect(decodeAsJSON(clean, { includeDropped: true }).dropped).toEqual([])
	})

	it("does not report a repeated span whose value is IDENTICAL — nothing was lost", () => {
		const repeated = tree("London, London", [node("locality", "London"), node("locality", "London")])

		expect(decodeAsJSON(repeated, { includeDropped: true }).dropped).toEqual([])
	})

	it("leaves the flat map byte-identical whether or not the report is asked for", () => {
		const { dropped: _dropped, ...withReport } = decodeAsJSON(TWO_LOCALITIES, { includeDropped: true })

		expect(withReport).toEqual(decodeAsJSON(TWO_LOCALITIES))
	})
})
