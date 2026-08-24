/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The own-name variant predicate (#1882) — every measured contest from the census, pinned so the threshold
 *   cannot drift past the cases it was chosen on. The comparator choice is itself a pinned decision: Jaro-Winkler's
 *   common-prefix bonus scored `chanchun`/`cancun` at 0.925 — ABOVE the real positives — so the predicate uses edit
 *   similarity, where the same pair reads 0.75.
 */

import {
	expandNameAbbreviations,
	isOwnNameVariant,
	ownNameSimilarity,
	romanizeNameKey,
	VARIANT_SIMILARITY_MIN,
} from "@mailwoman/resolver-wof-sqlite/candidate/own-name"
import { describe, expect, it } from "vitest"

describe("isOwnNameVariant — the measured census contests", () => {
	it("admits the holder's own name in another orthography", () => {
		// Brest, Belarus — the primary "Брэст" romanizes to the queried key exactly.
		expect(isOwnNameVariant("брэст", "brest")).toBe(true)
		// George Town, Penang — a spacing variant.
		expect(isOwnNameVariant("george town", "georgetown")).toBe(true)
		// Saint George's, Grenada — abbreviation expansion meets the possessive fold.
		expect(isOwnNameVariant("saint george s", "st georges")).toBe(true)
		// Адамовка — Polish-style romanization (w for v) sits inside the edit threshold.
		expect(isOwnNameVariant("адамовка", "adamowka")).toBe(true)
	})

	it("refuses the coincidental-collision class the penalty exists for", () => {
		// Changchun's Turkish exonym "Çançun" folds to `cancun` — the load-bearing negative: the query
		// means Cancún, Mexico, and the penalty must keep protecting it.
		expect(isOwnNameVariant("чанчунь", "cancun")).toBe(false)
		// Augsburg's Latin name `augusta` is a different name, not an orthography of "Augsburg".
		expect(isOwnNameVariant("augsburg", "augusta")).toBe(false)
		// West Bay, Cayman Islands carrying alias "West End" — different name.
		expect(isOwnNameVariant("west bay", "west end")).toBe(false)
	})

	it("refuses the near-identical DIFFERENT places (Liévin vs Levin) and the dual-name class (Derry/Londonderry)", () => {
		// Liévin, France vs Levin, New Zealand — 0.833, just under the floor; the panel's
		// `41 Weraroa Road, Levin` row needs Levin NZ to keep winning the primary side.
		expect(isOwnNameVariant("lievin", "levin")).toBe(false)
		// Derry/Londonderry is a dual name, not a variant — its own follow-up on #1882.
		expect(isOwnNameVariant("derry", "londonderry")).toBe(false)
	})

	it("answers no-verdict — never a stamp — on an uncovered script", () => {
		// Arabic-script primary (Abadan, Iran): the romanizer covers Cyrillic only, and absence of a
		// verdict must not read as "different name".
		expect(ownNameSimilarity("آبادان", "abadan")).toBeNull()
		expect(isOwnNameVariant("آبادان", "abadan")).toBe(false)
	})
})

describe("romanizeNameKey", () => {
	it("romanizes Cyrillic and passes Latin through folded", () => {
		expect(romanizeNameKey("брэст")).toBe("brest")
		expect(romanizeNameKey("адамовка")).toBe("adamovka")
		expect(romanizeNameKey("george town")).toBe("george town")
	})

	it("returns null when foreign characters survive", () => {
		expect(romanizeNameKey("阿克苏")).toBeNull()
		expect(romanizeNameKey("עכו")).toBeNull()
	})
})

describe("expandNameAbbreviations", () => {
	it("expands whole words only", () => {
		expect(expandNameAbbreviations("st georges")).toBe("saint georges")
		expect(expandNameAbbreviations("mt eden")).toBe("mount eden")
		// `st` inside a word never expands.
		expect(expandNameAbbreviations("stanley")).toBe("stanley")
	})
})

describe("VARIANT_SIMILARITY_MIN", () => {
	it("sits in the measured band: nearest admitted 0.875, nearest refused 0.833", () => {
		expect(VARIANT_SIMILARITY_MIN).toBe(0.85)
		expect(ownNameSimilarity("адамовка", "adamowka")).toBeCloseTo(0.875, 3)
		expect(ownNameSimilarity("lievin", "levin")).toBeCloseTo(0.833, 3)
	})
})
