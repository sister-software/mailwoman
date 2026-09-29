import type { ComponentTag } from "@mailwoman/codex/component"
import { type AddressNode, type AddressTree, decodeAsJSON, slotNodes } from "@mailwoman/core/decoder"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `slotNodes` decides which of two same-tag spans a projection reports.
 *
 *   A line that opens with a venue name the model labeled `street` puts that span first in the text.
 *   The real street follows it under the higher label confidence. An order taken from position reports
 *   the venue name as the street and deletes the street. The geocode path then has no street to resolve.
 *
 *   An administrative rung is the opposite case. A canonical line writes the rungs finest to coarsest.
 *   The coarser place name scores higher because it is more frequent in training. An order taken from
 *   confidence therefore answers `Bretagne` for a row whose locality is `Plougonvelin`.
 */
import { describe, expect, it } from "vitest"

function node(tag: ComponentTag, value: string, confidence: number, extra: Partial<AddressNode> = {}): AddressNode {
	return { tag, value, start: 0, end: value.length, confidence, children: [], ...extra }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

/**
 * `Label, C. de los Cabestreros 3, 28012 Madrid` as the shipped model parses it.
 *
 * The parse assigns `street` twice.
 * The confidences are the ones `mwdev_trace` reported for this row.
 */
const LEADING_VENUE_AS_STREET = tree("Label, C. de los Cabestreros 3, 28012 Madrid", [
	node("street", "Label", 0.584),
	node("street", "C. de los Cabestreros", 0.906),
])

describe("slot order among same-tag spans", () => {
	it("reports the higher-confidence street even though the other span comes first in the text", () => {
		expect(decodeAsJSON(LEADING_VENUE_AS_STREET).street).toBe("C. de los Cabestreros")
	})

	it("records the displaced span with the value that took the slot", () => {
		expect(decodeAsJSON(LEADING_VENUE_AS_STREET, { includeDropped: true }).dropped).toEqual([
			{ tag: "street", value: "Label", kept: "C. de los Cabestreros" },
		])
	})

	it("keeps the finer locality when a coarser trailing one scores higher", () => {
		// `Rue de l'Église, 3, 29217 Plougonvelin, Bretagne, France` as the shipped model parses it:
		// the trailing region is labeled `locality`, and `Bretagne` outscores `Plougonvelin`.
		const trailingRegion = tree("Rue de l'Église, 3, 29217 Plougonvelin, Bretagne, France", [
			node("locality", "Plougonvelin", 0.62),
			node("locality", "Bretagne", 0.94),
		])

		expect(decodeAsJSON(trailingRegion).locality).toBe("Plougonvelin")
	})

	it("keeps the finer locality when the coarser one is a single token and the finer one is not", () => {
		// A merged span takes the minimum of its token confidences.
		// `L'Hospitalet de Llobregat` is therefore scored by its weakest token
		// while `Barcelona` is scored by its only one.
		const spanish = tree("Carrer de Barcelona, 130, 08901 L'Hospitalet de Llobregat, Barcelona, Spain", [
			node("locality", "L'Hospitalet de Llobregat", 0.55),
			node("locality", "Barcelona", 0.97),
		])

		expect(decodeAsJSON(spanish).locality).toBe("L'Hospitalet de Llobregat")
	})

	it("keeps a grounded span ahead of an earlier ungrounded one", () => {
		// The grounding key outranks both later keys.
		// The resolved span therefore takes the slot from the span that document order
		// and confidence would both have chosen.
		const grounded = tree("Illes Balears, Portopetro", [
			node("locality", "Illes Balears", 0.98),
			node("locality", "Portopetro", 0.51, { lat: 39.37, lon: 3.29 }),
		])

		expect(decodeAsJSON(grounded).locality).toBe("Portopetro")
	})

	it("keeps document order when two spans outside the hierarchy share a confidence", () => {
		const tied = tree("Bar Centro, Bar Centro Annex", [
			node("venue", "Bar Centro", 0.9),
			node("venue", "Bar Centro Annex", 0.9),
		])

		expect(slotNodes(tied.roots).map((entry) => entry.value)).toEqual(["Bar Centro", "Bar Centro Annex"])
	})

	it("orders a child ahead of its parent when the child scores higher", () => {
		const nested = tree("Label, C. de los Cabestreros 3", [
			node("street", "Label", 0.584, { children: [node("street", "C. de los Cabestreros", 0.906)] }),
		])

		expect(decodeAsJSON(nested).street).toBe("C. de los Cabestreros")
	})
})
