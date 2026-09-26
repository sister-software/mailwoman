/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * An admin tail carrying a postcode is a locality query.
 *
 * The cases run through the real `computeQueryShape` rather than a hand-built shape, so a test asserts the
 * production reading rather than the rule's assumption: a postcode makes the whole input alphanumeric and
 * registers a known-format hit, and `scoreLocalityOnly` rejected on both.
 *
 * The verdict decides the parse register (`deriveInputMode`), whose `formatted` register withholds the
 * street-type and locality-surface lexicons, so the verdict on these rows decides whether the decoder sees
 * that evidence at all.
 */

import { classifyKindSync } from "@mailwoman/kind-classifier/classify"
import { withoutPostcodeSpans } from "@mailwoman/kind-classifier/rules"
import { computeQueryShape } from "@mailwoman/query-shape/compute"
import { describe, expect, it } from "vitest"

function kindOf(text: string): string {
	return classifyKindSync({ raw: text, normalized: text }, computeQueryShape(text)).kind
}

describe("withoutPostcodeSpans", () => {
	it("removes a postcode matched by several formats at once", () => {
		// `26292` is reported three times — us_zip, fr_postcode, de_postcode — at identical offsets,
		// so removing each hit in turn would delete 15 characters instead of 5 and shift every later offset.
		const text = "Thomas, WV 26292"

		expect(withoutPostcodeSpans(text, computeQueryShape(text))).toBe("Thomas WV")
	})

	it("leaves a hit outside the last segment in place", () => {
		const text = "3215 SE Clinton St, Portland OR"

		expect(withoutPostcodeSpans(text, computeQueryShape(text))).toBe(text)
	})

	it("returns input carrying no postcode unchanged", () => {
		// No text was removed, so no separator was orphaned and none is collapsed;
		// returning the input verbatim also keeps the length `scoreLocalityOnly`
		// measures identical to before this rule existed.
		const text = "Thomas, WV"

		expect(withoutPostcodeSpans(text, computeQueryShape(text))).toBe(text)
	})
})

describe("an admin tail carrying a postcode", () => {
	it.each([
		"Thomas, WV 26292",
		"Greer, SC 29651",
		"Saint Louis, MO 63131",
		"Overland Park, KS 66212",
		"Shenandoah Junction, WV 25442",
	])("classifies %s as locality_only", (text) => {
		expect(kindOf(text)).toBe("locality_only")
	})

	it.each([
		// A locality whose last word is USPS street-suffix vocabulary — 379 of the 1,132 shape-stratified
		// rows — so a rule that rejects the suffix word rejects the bucket these cases cover.
		"Pine Grove, WV 26419",
		"Folly Beach, SC 29439",
		"Wiley Ford, WV 26767",
		"Lake Delton, WI 53940",
	])("classifies the suffix-word locality %s as locality_only", (text) => {
		expect(kindOf(text)).toBe("locality_only")
	})

	it("keeps the postcode-free form it already classified", () => {
		expect(kindOf("Thomas, WV")).toBe("locality_only")
		expect(kindOf("Paris")).toBe("locality_only")
	})

	it("declines when the postcode hit falls outside the last segment", () => {
		// The detectors are speculative and multi-country: `3215 SE` reports as an
		// `nl_postcode`, and removing it would leave `Clinton St, Portland OR` alpha
		// and a locality query where a street address was typed.
		expect(kindOf("3215 SE Clinton St, Portland OR")).toBe("structured_address")

		// The same restriction declines a postcode-led tail, which no US address writes and
		// which cannot be told from the case above by any property this stage reads.
		expect(kindOf("26292 Thomas, WV")).not.toBe("locality_only")
	})

	it("declines input carrying no letter, which the character class alone calls alpha", () => {
		// `computeQueryShape("???")` reports `alpha`, because `foldInputClass` answers
		// `alpha` for input carrying no classified token; neither `locality_only`
		// nor its `bare_toponym` refinement may read that as a place name.
		expect(kindOf("???")).toBe("vague")
		expect(kindOf("!!!")).toBe("vague")
	})
})

describe("an address carrying street material", () => {
	it.each([
		// A leading house number is the structural cue the kind classifier routes on,
		// present here and absent from every row above.
		"153 Holloway Rd, London N7 8LX",
		"350 5th Ave, New York, NY 10118",
		"1600 Pennsylvania Ave NW, Washington, DC 20500",
	])("classifies %s as structured_address", (text) => {
		expect(kindOf(text)).toBe("structured_address")
	})

	it("leaves a bare postcode to postcode_only", () => {
		expect(kindOf("90210")).toBe("postcode_only")
	})
})
