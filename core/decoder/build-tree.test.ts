/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { BIOLabel } from "../types/component.ts"
import { buildAddressTree } from "./build-tree.ts"
import type { AddressNode, DecoderToken } from "./types.ts"

/** Construct a DecoderToken — confidence defaults to 1.0 for fixture brevity. */
function tok(piece: string, start: number, end: number, label: BIOLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

/**
 * "1600 Pennsylvania Avenue NW, Washington, DC 20500" 0 5 18 25 29 41 44
 */
function whiteHouseTokens(): DecoderToken[] {
	return [
		tok("1600", 0, 4, "B-house_number"),
		tok("Pennsylvania", 5, 17, "B-street"),
		tok("Avenue", 18, 24, "I-street"),
		tok("NW", 25, 27, "I-street"),
		tok(",", 27, 28, "O"),
		tok("Washington", 29, 39, "B-locality"),
		tok(",", 39, 40, "O"),
		tok("DC", 41, 43, "B-region"),
		tok("20500", 44, 49, "B-postcode"),
	]
}

const WHITE_HOUSE = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

describe("buildAddressTree", () => {
	test("emits one span per B-/I- group, dropping O", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		// 5 spans: house_number, street, locality, region, postcode
		const allTags: string[] = []
		const collect = (n: AddressNode): void => {
			allTags.push(n.tag)

			for (const c of n.children) {
				collect(c)
			}
		}

		for (const r of tree.roots) {
			collect(r)
		}
		expect(allTags.sort()).toEqual(["house_number", "locality", "postcode", "region", "street"])
	})

	test("groups B-street + I-street + I-street into one street span sliced from raw", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Pennsylvania Avenue NW")
		expect(street.start).toBe(5)
		expect(street.end).toBe(27)
	})

	test("nests house_number under street", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.children.map((c) => c.tag)).toContain("house_number")
	})

	test("nests street + postcode under locality (containment, not source order)", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const locality = findByTag(tree.roots, "locality")!
		const childTags = locality.children.map((c) => c.tag)
		expect(childTags).toContain("street")
		expect(childTags).toContain("postcode")
	})

	test("nests locality under region; region is the only root", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		expect(tree.roots.length).toBe(1)
		expect(tree.roots[0]!.tag).toBe("region")
		expect(tree.roots[0]!.children.map((c) => c.tag)).toEqual(["locality"])
	})

	test("source order preserved in sibling sort (street before postcode under locality)", () => {
		const tree = buildAddressTree(WHITE_HOUSE, whiteHouseTokens())
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.children.map((c) => c.tag)).toEqual(["street", "postcode"])
	})

	test("hanging I- with no prior B- starts a new span (lenient recovery)", () => {
		const raw = "Paris"
		const tokens: DecoderToken[] = [tok("Paris", 0, 5, "I-locality")]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots[0]?.tag).toBe("locality")
		expect(tree.roots[0]?.value).toBe("Paris")
	})

	test("confidence is the mean of token confidences across the span", () => {
		const raw = "Pennsylvania Avenue"
		const tokens: DecoderToken[] = [tok("Pennsylvania", 0, 12, "B-street", 0.8), tok("Avenue", 13, 19, "I-street", 0.6)]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots[0]!.confidence).toBeCloseTo(0.7, 5)
	})

	test("postcode-before-locality still attaches to locality (nearest-parent rule)", () => {
		// "75004 Paris"
		const raw = "75004 Paris"
		const tokens: DecoderToken[] = [tok("75004", 0, 5, "B-postcode"), tok("Paris", 6, 11, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.children.map((c) => c.tag)).toEqual(["postcode"])
	})
})

// Boundary-trim regression coverage. Samples sourced from v0.4.0's post-hoc regression
// diagnostic (.playpen/control/drafts/v0_4_0-regression-diagnostic.md). The shipped v0.4.0 model
// occasionally emits BIO spans with leading/trailing punctuation; the decoder now trims the span
// boundary past non-word characters. start/end tighten in sync so consumers slicing raw[start:end]
// get the same string as node.value.
describe("buildAddressTree — boundary trim", () => {
	test("strips leading comma+space from postcode span", () => {
		// Simulates ", 7647" pred for the gold "76470" — the slip from the diagnostic.
		const raw = ", 22220"
		const tokens: DecoderToken[] = [tok(", 22220", 0, 7, "B-postcode")]
		const tree = buildAddressTree(raw, tokens)
		const postcode = findByTag(tree.roots, "postcode")!
		expect(postcode.value).toBe("22220")
		expect(postcode.start).toBe(2)
		expect(postcode.end).toBe(7)
		expect(raw.slice(postcode.start, postcode.end)).toBe(postcode.value)
	})

	test("strips trailing punctuation from postcode span", () => {
		const raw = "Paris 75004,"
		const tokens: DecoderToken[] = [tok("Paris", 0, 5, "B-locality"), tok("75004,", 6, 12, "B-postcode")]
		const tree = buildAddressTree(raw, tokens)
		const postcode = findByTag(tree.roots, "postcode")!
		expect(postcode.value).toBe("75004")
		expect(postcode.end).toBe(11)
	})

	test("drops a span that trims to empty (all-punctuation)", () => {
		const raw = "350 5th Ave"
		const tokens: DecoderToken[] = [
			tok("350", 0, 3, "B-house_number"),
			tok(" ", 3, 4, "B-postcode"), // pathological model emission
			tok("5th", 4, 7, "B-street"),
			tok("Ave", 8, 11, "I-street"),
		]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots.some((r) => r.tag === "postcode")).toBe(false)
	})

	test("preserves Unicode letters (accents, non-Latin) in span values", () => {
		const raw = "Montréal, QC"
		const tokens: DecoderToken[] = [
			tok("Montréal", 0, 8, "B-locality"),
			tok(",", 8, 9, "O"),
			tok("QC", 10, 12, "B-region"),
		]
		const tree = buildAddressTree(raw, tokens)
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.value).toBe("Montréal")
	})

	test("does not trim word-internal punctuation (hyphens, apostrophes)", () => {
		const raw = "Sainte-Livrade-sur-Lot"
		const tokens: DecoderToken[] = [tok("Sainte-Livrade-sur-Lot", 0, 22, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots[0]!.value).toBe("Sainte-Livrade-sur-Lot")
	})
})

// Spurious-boundary repair. The neural model fragments some multi-word locality values into two
// B-locality spans ("Saint Paul" → B-locality "Saint" + B-locality "Paul") — a real, decode-
// agnostic emission bug (argmax == viterbi; see scripts/diag-saintalbans.ts). A `B-X` token that is
// whitespace-adjacent to an open `X` span is folded in; a comma/separator keeps spans distinct.
describe("buildAddressTree — adjacent same-tag merge (fragmentation repair)", () => {
	function localitySpans(nodes: AddressNode[]): AddressNode[] {
		const out: AddressNode[] = []
		const walk = (n: AddressNode): void => {
			if (n.tag === "locality") {
				out.push(n)
			}

			for (const c of n.children) {
				walk(c)
			}
		}

		for (const n of nodes) {
			walk(n)
		}

		return out
	}

	test("folds whitespace-adjacent B-locality B-locality into one span", () => {
		// "Saint Paul, MN" — model emits B-locality on BOTH "Saint" and "Paul".
		const raw = "Saint Paul, MN"
		const tokens: DecoderToken[] = [
			tok("Saint", 0, 5, "B-locality"),
			tok("Paul", 6, 10, "B-locality"),
			tok(",", 10, 11, "O"),
			tok("MN", 12, 14, "B-region"),
		]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(1)
		expect(locs[0]!.value).toBe("Saint Paul")
		expect(locs[0]!.start).toBe(0)
		expect(locs[0]!.end).toBe(10)
	})

	test("folds across a zero-width whitespace-only O artifact (real SentencePiece stream)", () => {
		// Exact stream observed from the model (scripts/diag-saintalbans.ts): SentencePiece emits a
		// standalone zero-width "▁" marker between the words, labeled O. It must not break the span.
		const raw = "Saint Paul, MN"
		const tokens: DecoderToken[] = [
			tok("▁Saint", 0, 5, "B-locality"),
			tok("▁", 6, 6, "O"),
			tok("Paul", 6, 10, "B-locality"),
			tok(",", 10, 11, "O"),
			tok("▁", 12, 12, "O"),
			tok("MN", 12, 14, "B-region"),
		]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(1)
		expect(locs[0]!.value).toBe("Saint Paul")
	})

	test("merges within a full address too (St + Albans → one locality)", () => {
		// "22 Brigham Rd, Saint Albans, VT 05478"
		const raw = "22 Brigham Rd, Saint Albans, VT 05478"
		const tokens: DecoderToken[] = [
			tok("22", 0, 2, "B-house_number"),
			tok("Brigham", 3, 10, "B-street"),
			tok("Rd", 11, 13, "I-street"),
			tok(",", 13, 14, "O"),
			tok("Saint", 15, 20, "B-locality"),
			tok("Albans", 21, 27, "B-locality"),
			tok(",", 27, 28, "O"),
			tok("VT", 29, 31, "B-region"),
			tok("05478", 32, 37, "B-postcode"),
		]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(1)
		expect(locs[0]!.value).toBe("Saint Albans")
	})

	test("GUARD: comma between same-tag spans keeps them distinct (no merge)", () => {
		// Two separate localities, comma in the gap (no intervening O token).
		const raw = "Dallas, Austin"
		const tokens: DecoderToken[] = [tok("Dallas", 0, 6, "B-locality"), tok("Austin", 8, 14, "B-locality")]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(2)
		expect(locs.map((l) => l.value).sort()).toEqual(["Austin", "Dallas"])
	})

	test("GUARD: intervening O token keeps same-tag spans distinct", () => {
		const raw = "Dallas , Austin"
		const tokens: DecoderToken[] = [
			tok("Dallas", 0, 6, "B-locality"),
			tok(",", 7, 8, "O"),
			tok("Austin", 9, 15, "B-locality"),
		]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(2)
	})

	test("merged span confidence is the mean across all folded tokens", () => {
		const raw = "Saint Paul"
		const tokens: DecoderToken[] = [tok("Saint", 0, 5, "B-locality", 0.9), tok("Paul", 6, 10, "B-locality", 0.5)]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs.length).toBe(1)
		expect(locs[0]!.confidence).toBeCloseTo(0.7, 5)
	})
})

// Diagnostic for the en-GB locale arc (docs/superpowers/specs/2026-07-22-en-gb-locale-arc-design.md,
// Phase 3): the spec assumed the word-consistency heal lumps "suburb, city" into one locality span.
// These characterize `emitSpans` directly to settle whether the decode pipeline itself preserves the
// dependent_locality/locality distinction across a comma.
describe("buildAddressTree — dependent_locality/locality comma separation (spec Phase-3 diagnostic)", () => {
	function tagsOf(nodes: AddressNode[]): string[] {
		const out: string[] = []
		const walk = (n: AddressNode): void => {
			out.push(n.tag)

			for (const c of n.children) {
				walk(c)
			}
		}

		for (const n of nodes) {
			walk(n)
		}

		return out
	}

	test("distinct tags across a comma stay two spans (Plimmerton, Porirua)", () => {
		// "Plimmerton, Porirua" — dependent_locality then (after the comma) locality.
		const raw = "Plimmerton, Porirua"
		const tokens: DecoderToken[] = [
			tok("Plimmerton", 0, 10, "B-dependent_locality"),
			tok(",", 10, 11, "O"),
			tok("Porirua", 12, 19, "B-locality"),
		]
		const tree = buildAddressTree(raw, tokens)
		const tags = tagsOf(tree.roots).sort()
		expect(tags).toEqual(["dependent_locality", "locality"])

		const depLocality = findByTag(tree.roots, "dependent_locality")!
		const locality = findByTag(tree.roots, "locality")!
		expect(depLocality.value).toBe("Plimmerton")
		expect(locality.value).toBe("Porirua")
	})

	test("GUARD: same-tag spans across a comma stay two spans (Springfield, Chicago)", () => {
		// Documents the comma guard already asserted in emitSpans: same-tag same-address spans
		// separated by a comma never merge, so a locality/locality "suburb, city" pair the model
		// emits as two distinct B-locality spans is not lumped by the decoder.
		const raw = "Springfield, Chicago"
		const tokens: DecoderToken[] = [
			tok("Springfield", 0, 11, "B-locality"),
			tok(",", 11, 12, "O"),
			tok("Chicago", 13, 20, "B-locality"),
		]
		const tree = buildAddressTree(raw, tokens)
		const localities: AddressNode[] = []
		const walk = (n: AddressNode): void => {
			if (n.tag === "locality") {
				localities.push(n)
			}

			for (const c of n.children) {
				walk(c)
			}
		}

		for (const r of tree.roots) {
			walk(r)
		}

		expect(localities.length).toBe(2)
		expect(localities.map((l) => l.value).sort()).toEqual(["Chicago", "Springfield"])
	})
})

function findByTag(nodes: AddressNode[], tag: string): AddressNode | null {
	for (const n of nodes) {
		if (n.tag === tag) return n
		const inChild = findByTag(n.children, tag)

		if (inChild) return inChild
	}

	return null
}
