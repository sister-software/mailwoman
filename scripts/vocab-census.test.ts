/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Fixture cases for the remedy classifier.
 *
 *   The classifier decides how ~2,000 comments get rewritten, so a case it silently reclassifies
 *   moves work between buckets with no failing check — the same shape as a false negative in any
 *   other measuring tool. Each case below states one line of real source and the remedy it earns.
 */

import { describe, expect, it } from "vitest"

import { classify, Remedy } from "./vocab-census.ts"

/**
 * Builds the Vale `--output line` record and the one-line source it points at.
 */
function hitFor(source: string, word: string): ReturnType<typeof classify> {
	const column = source.toLowerCase().indexOf(word.toLowerCase()) + 1

	return classify(
		[`a.ts:1:${column}:Mailwoman.AmbiguousShorthand:'${word}' is ambiguous shorthand`],
		new Map([["a.ts", [source]]])
	)
}

describe("a contract-bearing name earns the backtick remedy", () => {
	it.each([
		["\t// runs locale-gate over the query shape", "gate"],
		["\t * @mailwoman/locale-gate derives a LocaleHint.", "gate"],
		["\t// mwdev_gate answers from the warm engine.", "gate"],
	])("%s", (source, word) => {
		expect(hitFor(source, word)[0]?.remedy).toBe(Remedy.backtick)
	})
})

describe("a modifier that names the check earns the rename remedy", () => {
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

describe("a bare reference earns the read-context remedy", () => {
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
	it("a contract-bearing name wins even when an ordinary word precedes it", () => {
		// `the` would otherwise make this bare, and `pipeline` would otherwise make it a rename.
		const [hit] = hitFor("\t * Whatever the pipeline locale-gate says, the hint records it.", "gate")

		expect(hit?.remedy).toBe(Remedy.backtick)
	})

	it("a record whose line cannot be read is still counted, never dropped", () => {
		const hits = classify(["missing.ts:9:1:Mailwoman.AmbiguousShorthand:'gate' is ambiguous"], new Map())

		expect(hits).toHaveLength(1)
		expect(hits[0]?.remedy).toBe(Remedy.readContext)
	})

	it("ignores a line that is not a Vale record rather than counting it", () => {
		expect(classify(["", "Errors 0 Warnings 3"], new Map())).toEqual([])
	})

	it("finds the word when Vale's line number drifts, rather than bucketing a blank", () => {
		// A bare `//` line shifts Vale's numbering: a hit on line 1 gets reported as line 3. Trusting the
		// number reads an unrelated line, so the modifier comes out empty and the site lands in the
		// read-context bucket by accident. Two files in this repository drift, both by two.
		const source = [
			"\t// then fail the ambiguity gate for Nassau's rows",
			"\t//",
			"\t//",
			"\t// unrelated",
			"\t// also unrelated",
		]

		const [hit] = classify(
			["a.ts:3:22:Mailwoman.AmbiguousShorthandCode:'gate' is ambiguous"],
			new Map([["a.ts", source]])
		)

		expect(hit?.line).toBe(1)
		expect(hit?.modifier).toBe("ambiguity")
	})

	it("keeps a hit whose word is nowhere in the window rather than dropping it", () => {
		const [hit] = classify(
			["a.ts:2:1:Mailwoman.AmbiguousShorthandCode:'gate' is ambiguous"],
			new Map([["a.ts", ["x", "y"]]])
		)

		expect(hit).toBeDefined()
		expect(hit?.remedy).toBe(Remedy.readContext)
	})

	it("indexes source by ABSOLUTE line number, blank lines included", () => {
		// The driver reads files with `TextSpliterator.from(..., { skipEmpty: false })`. The default
		// drops blank lines, which shifts every line number after the first one — the hit below then
		// classifies against the wrong source line and lands in a different bucket with nothing
		// failing. Measured on the real corpus: the default moved 731 of 2,014 hits.
		const source = ["// header", "", "\t// then fail the ambiguity gate for Nassau's rows"]
		const [hit] = classify(["a.ts:3:22:Mailwoman.AmbiguousShorthand:'gate' is ambiguous"], new Map([["a.ts", source]]))

		expect(hit?.modifier).toBe("ambiguity")
		expect(hit?.remedy).toBe(Remedy.renameCheck)
	})
})
