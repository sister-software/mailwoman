/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the invariance mini-suite's perturbation classes — pure functions, no model, no I/O.
 */

import { describe, expect, it } from "vitest"

import { canonicalizeAbbreviations, getTransform, TRANSFORMS } from "./transforms.ts"

describe("TRANSFORMS registry", () => {
	it("carries the seven classes the spec names", () => {
		const ids = TRANSFORMS.map((t) => t.id).sort()

		expect(ids).toEqual(
			[
				"abbreviation-swap",
				"case-fold",
				"comma-drop",
				"idempotence",
				"lowercase",
				"trailing-punct",
				"whitespace-jitter",
			].sort()
		)
	})

	it("every transform carries a non-empty literature anchor", () => {
		for (const t of TRANSFORMS) {
			expect(t.literatureAnchor.length).toBeGreaterThan(10)
		}
	})
})

describe("getTransform", () => {
	it("resolves a known id", () => {
		expect(getTransform("comma-drop").id).toBe("comma-drop")
	})

	it("throws loudly on an unknown id", () => {
		expect(() => getTransform("nope")).toThrow(/unknown invariance transform id/)
	})
})

describe("comma-drop", () => {
	const commaDrop = getTransform("comma-drop").apply

	it("removes every comma", () => {
		expect(commaDrop("1600 Pennsylvania Ave NW, Washington, DC 20500")).toBe(
			"1600 Pennsylvania Ave NW Washington DC 20500"
		)
	})

	it("returns null when there's no comma to drop", () => {
		expect(commaDrop("1 Infinite Loop Cupertino CA 95014")).toBeNull()
	})
})

describe("abbreviation-swap", () => {
	const swap = getTransform("abbreviation-swap").apply

	it("swaps a long form to its short form", () => {
		expect(swap("350 Fifth Avenue, New York, NY")).toBe("350 Fifth Ave, New York, NY")
	})

	it("swaps a short form to its long form", () => {
		expect(swap("1600 Pennsylvania Ave NW, Washington DC")).toBe("1600 Pennsylvania Avenue NW, Washington DC")
	})

	it("swaps Road <-> Rd", () => {
		expect(swap("10 Station Road, Cropredy")).toBe("10 Station Rd, Cropredy")
	})

	it("returns null when no swappable token is present", () => {
		expect(swap("181 Rue du Chevaleret, 75013 Paris")).toBeNull()
	})

	it("skips a LEADING 'St' (Saint-prefix), but still swaps a later Avenue", () => {
		expect(swap("St Bedes Avenue, Fishburn, Stockton-on-Tees")).toBe("St Bedes Ave, Fishburn, Stockton-on-Tees")
	})

	it("returns null for a bare leading 'St' with no other swappable token", () => {
		expect(swap("St Ives, Cornwall")).toBeNull()
	})

	it("the Saint-prefix guard isn't index-0-only — protects a mid-string 'St <Name>' and swaps the real suffix instead", () => {
		// The reviewer's reproduction: a naive index-0-only guard misses "St" here (it's the third token, not
		// the first) and corrupts "St Andrews" into "Street Andrews". The fix must both (a) leave "St Andrews"
		// alone and (b) still find the standalone "Street" suffix token later in the string.
		expect(swap("The Vicarage, St Andrews Street, Cambridge")).toBe("The Vicarage, St Andrews St, Cambridge")
	})

	it("does NOT treat 'St' followed by a secondary-address designator (Apt/Ste) as a Saint-prefix", () => {
		expect(swap("123 Main St Apt 4B, Springfield, IL 62701")).toBe("123 Main Street Apt 4B, Springfield, IL 62701")
		expect(swap("500 W 7th St Ste 1100, Cincinnati, OH 45203-1234")).toBe(
			"500 W 7th Street Ste 1100, Cincinnati, OH 45203-1234"
		)
	})

	it("does NOT treat a phrase-final 'St,' (own trailing punctuation) as a Saint-prefix, even before a capitalized place name", () => {
		// "St" here closes the street phrase right before the next comma-delimited component — the
		// own-trailing-punctuation discriminator, not the following-word one, is what correctly lets this swap
		// even though "Portland" (like "Andrews") is a capitalized non-suffix word.
		expect(swap("6220 SE Salmon St, Portland, OR 97215, USA")).toBe("6220 SE Salmon Street, Portland, OR 97215, USA")
	})
})

describe("case-fold / lowercase", () => {
	it("case-fold upper-cases", () => {
		expect(getTransform("case-fold").apply("350 Fifth Avenue")).toBe("350 FIFTH AVENUE")
	})

	it("lowercase lower-cases", () => {
		expect(getTransform("lowercase").apply("350 Fifth Avenue")).toBe("350 fifth avenue")
	})

	it("both are always applicable — never null", () => {
		expect(getTransform("case-fold").apply("")).not.toBeNull()
		expect(getTransform("lowercase").apply("")).not.toBeNull()
	})
})

describe("whitespace-jitter", () => {
	it("doubles every space", () => {
		expect(getTransform("whitespace-jitter").apply("350 Fifth Avenue")).toBe("350  Fifth  Avenue")
	})

	it("returns null when there's no whitespace at all", () => {
		expect(getTransform("whitespace-jitter").apply("Rathausplatz")).toBeNull()
	})

	it("returns null when whitespace is present but none of it is a literal space (guard must match the mutation)", () => {
		// The mutation only doubles literal " " characters. A guard that accepts any `\s` (tabs, etc.) but
		// finds no space to double is a silent no-op INVARIANT — the transform claims it ran but nothing
		// actually changed.
		expect(getTransform("whitespace-jitter").apply("A\tB")).toBeNull()
	})
})

describe("trailing-punct", () => {
	it("appends a period", () => {
		expect(getTransform("trailing-punct").apply("350 Fifth Avenue")).toBe("350 Fifth Avenue.")
	})
})

describe("canonicalizeAbbreviations", () => {
	it("expands Ave/St/Rd tokens to long form", () => {
		expect(canonicalizeAbbreviations("Pennsylvania Ave NW")).toBe("Pennsylvania Avenue NW")
		expect(canonicalizeAbbreviations("St")).toBe("Street")
		expect(canonicalizeAbbreviations("Rd")).toBe("Road")
	})

	it("leaves an already-long form alone", () => {
		expect(canonicalizeAbbreviations("Pennsylvania Avenue NW")).toBe("Pennsylvania Avenue NW")
	})

	it("leaves a value with no swappable token alone", () => {
		expect(canonicalizeAbbreviations("Rue du Chevaleret")).toBe("Rue du Chevaleret")
	})

	it("makes an abbreviation-swap pair compare equal after canonicalizing both sides", () => {
		const before = canonicalizeAbbreviations("Pennsylvania Ave NW")
		const after = canonicalizeAbbreviations("Pennsylvania Avenue NW")

		expect(before).toBe(after)
	})
})

describe("idempotence", () => {
	it("is the identity function", () => {
		expect(getTransform("idempotence").apply("350 Fifth Avenue")).toBe("350 Fifth Avenue")
	})
})
