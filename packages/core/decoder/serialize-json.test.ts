/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opt-in `dropped` surface (#1755) — which spans the flat projection could not represent.
 *
 *   `decodeAsJSON` holds one value per tag, so a tree carrying two `locality` spans emits one and the other ceases
 *   to exist. Without a report, `region: null` means both "the input named no region" and "it named one and we
 *   deleted it". The #1748 trailing region is the worked case: parsed, mistagged `locality`, deleted here — which
 *   is why no decode lever could ever move that class.
 */
import { describe, expect, it } from "vitest"

import type { ComponentTag } from "../types/component.ts"
import { decodeAsJSON } from "./serialize-json.ts"
import type { AddressNode, AddressTree } from "./types.ts"

function node(tag: ComponentTag, value: string, children: AddressNode[] = []): AddressNode {
	return { tag, value, start: 0, end: value.length, confidence: 1, children }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

/**
 * `country › locality "Portopetro" › postcode`, plus a SECOND `locality` sibling.
 *
 * That sibling is the #1748 trailing region as the shipped model actually parses it — the span exists, carries the
 * right text, and wears the wrong tag.
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
