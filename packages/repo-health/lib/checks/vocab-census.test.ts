/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Fixture cases for the action classifier.
 *
 *   A silently reclassified comment moves work between buckets with no failing check.
 */

import { describe, expect, it } from "vitest"

import { classify, Remedy } from "#checks/vocab-census"

function hitFor(source: string, word: string): ReturnType<typeof classify> {
	const column = source.toLowerCase().indexOf(word.toLowerCase()) + 1

	return classify(
		[`a.ts:1:${column}:styles.AmbiguousShorthand:'${word}' is ambiguous shorthand`],
		new Map([["a.ts", [source]]])
	)
}

describe("the classifier reads the rule name Vale emits", () => {
	it("classifies a record whose rule name carries the style package `.vale-code-census.ini` declares", () => {
		// Vale prefixes a rule with its style package, which `BasedOnStyles` sets to `styles`.
		// A pattern naming another package matches no record, so `collectHits` returns an empty
		// array for a tree that has hits and the census reports a count of zero it did not measure.
		// The fixtures above spell the emitted form for that reason, and this case
		// states it directly rather than relying on them.
		const hits = classify(
			["a.ts:1:5:styles.AmbiguousShorthandCode:'gate' is ambiguous"],
			new Map([["a.ts", ["// the gate holds"]]])
		)

		expect(hits).toHaveLength(1)
		expect(hits[0]!.word).toBe("gate")
	})

	it("classifies no record under a style package no config declares", () => {
		expect(classify(["a.ts:1:5:Mailwoman.AmbiguousShorthandCode:'gate' is ambiguous"], new Map())).toEqual([])
	})
})

describe("a modifier that names the check warrants the rename remedy", () => {
	it.each([
		["\t// then fail the ambiguity gate for Nassau's rows", "gate", "ambiguity"],
		["\t * the street-context gate's signal is the deciding one", "gate", "street-context"],
		["\t * padded containment gated on no leading zero", "gated", "containment"],
	])("%s", (source, word, modifier) => {
		const [hit] = hitFor(source, word)

		expect(hit?.remedy).toBe(Remedy.renameCheck)
		expect(hit?.modifier).toBe(modifier)
	})
})

describe("a bare reference warrants the read-context remedy", () => {
	it.each([
		["\t// The gate needs BOTH matchers.", "gate"],
		["\t// surfaced as a gate — the resolver never sees it", "gate"],
		["\t * `minRequestIntervalMs` is the gate", "gate"],
		["\t * `blitFrame` is the seam back the other way", "seam"],
	])("%s", (source, word) => {
		expect(hitFor(source, word)[0]?.remedy).toBe(Remedy.readContext)
	})
})

describe("the classifier reads the whole line, not only the modifier", () => {
	it("a record whose line cannot be read is still counted, never dropped", () => {
		const hits = classify(["missing.ts:9:1:styles.AmbiguousShorthand:'gate' is ambiguous"], new Map())

		expect(hits).toHaveLength(1)
		expect(hits[0]?.remedy).toBe(Remedy.readContext)
	})

	it("ignores a line that is not a Vale record rather than counting it", () => {
		expect(classify(["", "Errors 0 Warnings 3"], new Map())).toEqual([])
	})

	it("finds the word when Vale's line number drifts, rather than bucketing a blank", () => {
		const source = [
			"\t// then fail the ambiguity gate for Nassau's rows",
			"\t//",
			"\t//",
			"\t// unrelated",
			"\t// also unrelated",
		]

		const [hit] = classify(["a.ts:3:22:styles.AmbiguousShorthandCode:'gate' is ambiguous"], new Map([["a.ts", source]]))

		expect(hit?.line).toBe(1)
		expect(hit?.modifier).toBe("ambiguity")
	})

	it("keeps a hit whose word is nowhere in the window rather than dropping it", () => {
		const [hit] = classify(
			["a.ts:2:1:styles.AmbiguousShorthandCode:'gate' is ambiguous"],
			new Map([["a.ts", ["x", "y"]]])
		)

		expect(hit).toBeDefined()
		expect(hit?.remedy).toBe(Remedy.readContext)
	})

	it("indexes source by ABSOLUTE line number, blank lines included", () => {
		const source = ["// header", "", "\t// then fail the ambiguity gate for Nassau's rows"]
		const [hit] = classify(["a.ts:3:22:styles.AmbiguousShorthand:'gate' is ambiguous"], new Map([["a.ts", source]]))

		expect(hit?.modifier).toBe("ambiguity")
		expect(hit?.remedy).toBe(Remedy.renameCheck)
	})
})
