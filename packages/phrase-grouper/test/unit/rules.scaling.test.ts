/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every per-segment rule must stay linear in segment length, including on the input shape that makes it work
 *   hardest: a long run of capitalized tokens, every one of which is candidate place-name content.
 *
 *   `scoreLocalityPhrase` walks forward from each start index to measure the run it could propose. That walk has to
 *   stay bounded by {@link MAX_LOCALITY_PHRASE_TOKENS}, because the proposals it feeds are clamped to that length
 *   anyway — unbounded, every start index walks to the end of the run and the segment costs quadratic time for an
 *   identical result.
 *
 *   Correctness tests cannot catch that: bounded and unbounded walks emit the same proposals, which is what makes the
 *   waste invisible. Only the growth curve separates them. The curve is measured by operation count — the number of
 *   token reads a rule makes, observed through a `Proxy` over the token array — rather than by wall clock: a token
 *   read is what the walk spends, it is exact, and it does not move with whatever else the host is running — a
 *   wall-clock ratio on a shared host cannot tell a load change between its two measurements from a complexity change.
 */

import {
	MAX_LOCALITY_PHRASE_TOKENS,
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	tokenizeSegment,
	type SegmentToken,
} from "@mailwoman/phrase-grouper/rules"
import { describe, expect, test } from "vitest"

/**
 * Every token is capitalized place-name content and nothing terminates the run —
 * the worst case for a forward walk, and the shape a pasted document produces.
 */
const CAPS_RUN_UNIT = "Aa "

/**
 * A doubled input doubles a linear read count and quadruples a quadratic one.
 * The bound sits well below the midpoint: the only departure from 2.0 a linear rule
 * shows is the run's tail, where the last few start indices find fewer tokens to read,
 * and that shortfall shrinks as the input grows.
 */
const MAX_LINEAR_GROWTH = 2.2

/**
 * Token reads the locality walk may spend per start index.
 * The head is read three times before the walk, the walk looks ahead at most
 * `MAX_LOCALITY_PHRASE_TOKENS - 1` tokens, and each of the `MAX_LOCALITY_PHRASE_TOKENS`
 * proposal lengths reads its two endpoints — 3 + 5 + 12 = 20 at the shipped cap.
 * Four reads per cap token leaves room for the shape of those reads to change
 * without letting the walk range past the cap.
 */
const MAX_LOCALITY_READS_PER_TOKEN = 4 * MAX_LOCALITY_PHRASE_TOKENS

interface CountingTokens {
	readonly tokens: ReadonlyArray<SegmentToken>
	readonly reads: () => number
}

/**
 * The token array behind a `Proxy` that counts every indexed read.
 * A rule that walks further reads more, so the count is the walk's length in the unit the walk is paid in.
 */
function countingTokens(tokens: ReadonlyArray<SegmentToken>): CountingTokens {
	let reads = 0

	const proxied = new Proxy(tokens, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) {
				reads++
			}

			return Reflect.get(target, property, receiver)
		},
	})

	return { tokens: proxied, reads: () => reads }
}

function capsRun(chars: number): { text: string; tokens: SegmentToken[] } {
	const text = CAPS_RUN_UNIT.repeat(Math.ceil(chars / CAPS_RUN_UNIT.length))

	return { text, tokens: tokenizeSegment(text, 0) }
}

const RULES: ReadonlyArray<{
	name: string
	run: (tokens: ReadonlyArray<SegmentToken>, text: string) => unknown
}> = [
	{ name: "scoreNumeric", run: (tokens, text) => scoreNumeric(tokens, text) },
	{ name: "scoreRegionAbbreviation", run: (tokens, text) => scoreRegionAbbreviation(tokens, text, true) },
	{ name: "scoreHyphenatedCompound", run: (tokens, text) => scoreHyphenatedCompound(tokens, text) },
	{ name: "scoreStreetPhrase", run: (tokens, text) => scoreStreetPhrase(tokens, text) },
	{ name: "scoreLocalityPhrase", run: (tokens, text) => scoreLocalityPhrase(tokens, text, true) },
	{ name: "scoreVenuePhrase", run: (tokens, text) => scoreVenuePhrase(tokens, text, true) },
]

function readsAt(chars: number, run: (typeof RULES)[number]["run"]): { reads: number; tokenCount: number } {
	const { text, tokens } = capsRun(chars)
	const counting = countingTokens(tokens)

	run(counting.tokens, text)

	return { reads: counting.reads(), tokenCount: tokens.length }
}

describe("every per-segment rule reads a linear number of tokens on a long capitalized run", () => {
	test.each(RULES)("$name", ({ run }) => {
		const small = readsAt(10_000, run)
		const large = readsAt(20_000, run)
		const growth = large.reads / small.reads

		expect(
			growth,
			`doubling the input multiplied the token reads by ${growth.toFixed(2)}x ` +
				`(${small.reads} reads over ${small.tokenCount} tokens -> ${large.reads} over ${large.tokenCount}). ` +
				`Linear is 2x; quadratic is 4x. A walk in phrase-grouper/rules.ts ranges with the segment length.`
		).toBeLessThan(MAX_LINEAR_GROWTH)
	})
})

test("the locality walk reads no further than MAX_LOCALITY_PHRASE_TOKENS from each start index", () => {
	const { reads, tokenCount } = readsAt(10_000, RULES.find((rule) => rule.name === "scoreLocalityPhrase")!.run)
	const readsPerToken = reads / tokenCount

	expect(
		readsPerToken,
		`scoreLocalityPhrase read ${readsPerToken.toFixed(2)} tokens per start index over ${tokenCount} tokens. ` +
			`The forward walk has most likely stopped respecting MAX_LOCALITY_PHRASE_TOKENS.`
	).toBeLessThanOrEqual(MAX_LOCALITY_READS_PER_TOKEN)
})
