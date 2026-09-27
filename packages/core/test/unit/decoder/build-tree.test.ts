import { buildAddressTree } from "@mailwoman/core/decoder/build-tree"
import type { AddressNode, DecoderToken } from "@mailwoman/core/decoder/types"
import { describe, expect, test } from "vitest"

import { findByTag, tok, WHITE_HOUSE_RAW, whiteHouseTokens } from "./fixtures.ts"

describe("buildAddressTree", () => {
	test("Emits one span per B-/I- group, dropping O", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())

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

		expect(allTags.toSorted()).toEqual(["house_number", "locality", "postcode", "region", "street"])
	})

	test("groups B-street + I-street + I-street into one street span taken from raw", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Pennsylvania Avenue NW")
		expect(street.start).toBe(5)
		expect(street.end).toBe(27)
	})

	test("nests house_number under street", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())
		const street = findByTag(tree.roots, "street")!
		expect(street.children.map((c) => c.tag)).toContain("house_number")
	})

	test("nests street + postcode under locality (containment, not source order)", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())
		const locality = findByTag(tree.roots, "locality")!
		const childTags = locality.children.map((c) => c.tag)
		expect(childTags).toContain("street")
		expect(childTags).toContain("postcode")
	})

	test("nests locality under region; region is the only root", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())
		expect(tree.roots).toHaveLength(1)
		expect(tree.roots[0]!.tag).toBe("region")
		expect(tree.roots[0]!.children.map((c) => c.tag)).toEqual(["locality"])
	})

	test("source order preserved in sibling sort (street before postcode under locality)", () => {
		const tree = buildAddressTree(WHITE_HOUSE_RAW, whiteHouseTokens())
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
		const raw = "75004 Paris"
		const tokens: DecoderToken[] = [tok("75004", 0, 5, "B-postcode"), tok("Paris", 6, 11, "B-locality")]
		const tree = buildAddressTree(raw, tokens)
		const locality = findByTag(tree.roots, "locality")!
		expect(locality.children.map((c) => c.tag)).toEqual(["postcode"])
	})
})

describe("buildAddressTree — boundary trim", () => {
	test("strips leading comma+space from postcode span", () => {
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
			tok(" ", 3, 4, "B-postcode"),
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

	test("Preserves trailing abbreviation period ( trailing-dot fix)", () => {
		const raw = "Neusser Str. 12"

		const tokens: DecoderToken[] = [
			tok("Neusser", 0, 7, "B-street"),
			tok("Str.", 8, 12, "I-street"),
			tok("12", 13, 15, "B-house_number"),
		]

		const tree = buildAddressTree(raw, tokens)

		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Neusser Str.")
		expect(raw.slice(street.start, street.end)).toBe("Neusser Str.")
	})

	test("strips trailing comma but preserves abbreviation period", () => {
		const raw = "Neusser Str., 12"

		const tokens: DecoderToken[] = [
			tok("Neusser", 0, 7, "B-street"),
			tok("Str.,", 8, 13, "I-street"),
			tok("12", 14, 16, "B-house_number"),
		]

		const tree = buildAddressTree(raw, tokens)
		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Neusser Str.")
		expect(raw.slice(street.start, street.end)).toBe("Neusser Str.")
	})

	test("preserves abbreviation period on single-token street span", () => {
		const raw = "Av. Paulista, 100"

		const tokens: DecoderToken[] = [
			tok("Av.", 0, 3, "B-street"),
			tok("Paulista,", 4, 13, "I-street"),
			tok("100", 14, 17, "B-house_number"),
		]

		const tree = buildAddressTree(raw, tokens)

		const street = findByTag(tree.roots, "street")!
		expect(street.value).toBe("Av. Paulista")
	})
})

describe("buildAddressTree — paired-punctuation span-edge trimming", () => {
	test('Strips a wrapping straight-quote pair from a venue-shaped span ("The Grange")', () => {
		const raw = '"The Grange", Fishburn'

		const tokens: DecoderToken[] = [
			tok('"The', 0, 4, "B-venue"),
			tok('Grange",', 5, 13, "I-venue"),
			tok("Fishburn", 14, 22, "B-locality"),
		]

		const tree = buildAddressTree(raw, tokens)
		const venue = findByTag(tree.roots, "venue")!
		expect(venue.value).toBe("The Grange")
		expect(raw.slice(venue.start, venue.end)).toBe("The Grange")
	})

	test("Strips a wrapping parenthetical from an aside-shaped span (rear entrance)", () => {
		const raw = "12 High St (rear entrance), Leeds"
		const tokens: DecoderToken[] = [tok("(rear", 11, 16, "B-unit"), tok("entrance),", 17, 27, "I-unit")]
		const tree = buildAddressTree(raw, tokens)
		const unit = findByTag(tree.roots, "unit")!
		expect(unit.value).toBe("rear entrance")
	})

	test("Strips a wrapping bracket pair from a designator-shaped span [Block B]", () => {
		const raw = "Unit 4 [Block B]"
		const tokens: DecoderToken[] = [tok("[Block", 7, 13, "B-unit"), tok("B]", 14, 16, "I-unit")]
		const tree = buildAddressTree(raw, tokens)
		const unit = findByTag(tree.roots, "unit")!
		expect(unit.value).toBe("Block B")
	})

	test("Strips a wrapping brace pair {Block C}", () => {
		const raw = "{Block C}, Leeds"
		const tokens: DecoderToken[] = [tok("{Block", 0, 6, "B-unit"), tok("C},", 7, 10, "I-unit")]
		const tree = buildAddressTree(raw, tokens)
		const unit = findByTag(tree.roots, "unit")!
		expect(unit.value).toBe("Block C")
	})

	test("Strips wrapping guillemets «The Grange»", () => {
		const raw = "«The Grange», Fishburn"

		const tokens: DecoderToken[] = [
			tok("«The", 0, 4, "B-venue"),
			tok("Grange»,", 5, 13, "I-venue"),
			tok("Fishburn", 14, 22, "B-locality"),
		]

		const tree = buildAddressTree(raw, tokens)
		const venue = findByTag(tree.roots, "venue")!
		expect(venue.value).toBe("The Grange")
	})

	test("strips curly quotes “The Grange” the same way as straight quotes", () => {
		const raw = "“The Grange”, Fishburn"
		const tokens: DecoderToken[] = [tok("“The", 0, 4, "B-venue"), tok("Grange”,", 5, 13, "I-venue")]
		const tree = buildAddressTree(raw, tokens)
		const venue = findByTag(tree.roots, "venue")!
		expect(venue.value).toBe("The Grange")
	})

	test("UNBALANCED leading quote (no closer anywhere) still trims cleanly without throwing", () => {
		const raw = '"The Grange, Fishburn'

		const tokens: DecoderToken[] = [
			tok('"The', 0, 4, "B-venue"),
			tok("Grange,", 5, 12, "I-venue"),
			tok("Fishburn", 13, 21, "B-locality"),
		]

		expect(() => buildAddressTree(raw, tokens)).not.toThrow()
		const venue = findByTag(buildAddressTree(raw, tokens).roots, "venue")!
		expect(venue.value).toBe("The Grange")
	})

	test("UNBALANCED trailing paren (no opener anywhere) still trims cleanly without throwing", () => {
		const raw = "12 High St rear entrance), Leeds"
		const tokens: DecoderToken[] = [tok("rear", 11, 15, "B-unit"), tok("entrance),", 16, 26, "I-unit")]
		expect(() => buildAddressTree(raw, tokens)).not.toThrow()
		const unit = findByTag(buildAddressTree(raw, tokens).roots, "unit")!
		expect(unit.value).toBe("rear entrance")
	})

	test("an all-punctuation paired-quote-only span (empty content) is dropped, not crashed on", () => {
		const raw = '"", Fishburn'
		const tokens: DecoderToken[] = [tok('"",', 0, 3, "B-venue"), tok("Fishburn", 4, 12, "B-locality")]
		expect(() => buildAddressTree(raw, tokens)).not.toThrow()
		const tree = buildAddressTree(raw, tokens)
		expect(tree.roots.some((r) => r.tag === "venue")).toBe(false)
	})
})

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
		const raw = "Saint Paul, MN"

		const tokens: DecoderToken[] = [
			tok("Saint", 0, 5, "B-locality"),
			tok("Paul", 6, 10, "B-locality"),
			tok(",", 10, 11, "O"),
			tok("MN", 12, 14, "B-region"),
		]

		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs).toHaveLength(1)
		expect(locs[0]!.value).toBe("Saint Paul")
		expect(locs[0]!.start).toBe(0)
		expect(locs[0]!.end).toBe(10)
	})

	test("folds across a zero-width whitespace-only O artifact (real SentencePiece stream)", () => {
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
		expect(locs).toHaveLength(1)
		expect(locs[0]!.value).toBe("Saint Paul")
	})

	test("Merges within a full address too (St + Albans → one locality)", () => {
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
		expect(locs).toHaveLength(1)
		expect(locs[0]!.value).toBe("Saint Albans")
	})

	test("Comma between same-tag spans keeps them distinct (no merge)", () => {
		const raw = "Dallas, Austin"
		const tokens: DecoderToken[] = [tok("Dallas", 0, 6, "B-locality"), tok("Austin", 8, 14, "B-locality")]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs).toHaveLength(2)
		expect(locs.map((l) => l.value).toSorted()).toEqual(["Austin", "Dallas"])
	})

	test("Intervening O token keeps same-tag spans distinct", () => {
		const raw = "Dallas , Austin"

		const tokens: DecoderToken[] = [
			tok("Dallas", 0, 6, "B-locality"),
			tok(",", 7, 8, "O"),
			tok("Austin", 9, 15, "B-locality"),
		]

		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs).toHaveLength(2)
	})

	test("merged span confidence is the mean across all folded tokens", () => {
		const raw = "Saint Paul"
		const tokens: DecoderToken[] = [tok("Saint", 0, 5, "B-locality", 0.9), tok("Paul", 6, 10, "B-locality", 0.5)]
		const locs = localitySpans(buildAddressTree(raw, tokens).roots)
		expect(locs).toHaveLength(1)
		expect(locs[0]!.confidence).toBeCloseTo(0.7, 5)
	})
})

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
		const raw = "Plimmerton, Porirua"

		const tokens: DecoderToken[] = [
			tok("Plimmerton", 0, 10, "B-dependent_locality"),
			tok(",", 10, 11, "O"),
			tok("Porirua", 12, 19, "B-locality"),
		]

		const tree = buildAddressTree(raw, tokens)
		const tags = tagsOf(tree.roots).toSorted()
		expect(tags).toEqual(["dependent_locality", "locality"])

		const depLocality = findByTag(tree.roots, "dependent_locality")!
		const locality = findByTag(tree.roots, "locality")!
		expect(depLocality.value).toBe("Plimmerton")
		expect(locality.value).toBe("Porirua")
	})

	test("Same-tag spans across a comma stay two spans (Springfield, Chicago)", () => {
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

		expect(localities).toHaveLength(2)
		expect(localities.map((l) => l.value).toSorted()).toEqual(["Chicago", "Springfield"])
	})
})
