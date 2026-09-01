/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NO DIGIT-OWNERSHIP BOARD — which tag owns a digit-bearing token (Track B).
 *
 *   The third standing board. Board 1 is the global parity floor (`parity-corpus.ts`, broad, "do no
 *   harm"); board 2 is the FR locale fragment board (`fragment-board.ts`, street polarity); this is
 *   board 3, and it exists because Track B's entire defect was visible only as `postcode 25/249 =
 *   0.100` on the parity precision half — 25 rows, no subclass, no interval. A board that cannot put
 *   a CI on a cell cannot grade a fix.
 *
 *   WHY NORWAY. `#901` measured a 30% residual on Norwegian street-led forms, diagnosed it as
 *   order-sensitive decode, and built `synth-no-street-led` at source weight 12.0 — the maximum
 *   targeted-fix tier — to close it. The YAML Norway problem (`NO:` resolves to the boolean `false`
 *   under YAML 1.1, so `country_weights.get("NO")` misses and the loader drops every row) meant that
 *   database never contributed a single row to any run since v1.9.0. The fix is #1145.
 *
 *   That makes the baseline unusually clean: SHIPPED v310 has never seen one Norwegian address, so
 *   this board's v310 arm is a TRUE ZERO-KNOWLEDGE reading, not a weak-prior one. Register it before
 *   the retrain exists.
 *
 *   THE NEGATIVE CLASS IS THE POINT — the same lesson as board 2's `bare-locality`. Every positive
 *   class here rewards "call the digit a house_number", so a model can ace all five by never
 *   emitting postcode again. `bare-pc` rows carry `expect_no_house_number` and score whether the
 *   parser still reads a real postcode as a postcode. Without it the board cannot tell a learned
 *   DISTINCTION from a flipped DEFAULT, which is exactly the trade board 2 caught v310 NOT making
 *   (bare-locality held 0.980 -> 0.980).
 *
 *   WHY `bare-street-hn` MATTERS MOST DIAGNOSTICALLY: it carries no postcode at all, so nothing
 *   competes for the digit. If the model still says postcode there, the defect is not a
 *   postcode-vs-house_number competition and the whole framing is wrong.
 *
 *   SPLIT: surfaces are reserved in `no-digits.surfaces.txt` and `no-street-led` REQUIRES
 *   `--exclude-surfaces` (it throws otherwise). Source-disjoint by normalized street SURFACE, never
 *   by record row — row-disjoint leaks the surface across the boundary and measures memorization.
 *
 *   SLASH HAZARD: Norwegian `124/1` is ONE component (cadastral gnr/bnr); Australian `12/345` is TWO
 *   (unit 12 + house_number 345). Identical surface shape, opposite correct answers. `slash-hn` pins
 *   the Norwegian reading so a future AU intra-word-split database cannot generalize over it unnoticed.
 */

import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import {
	runSpanBoard,
	type SpanBoardFixture,
	type SpanBoardOptions,
	type SpanBoardOutcome,
} from "#eval-harness/span-board"

/**
 * Fixture set backing the digit board — house-number and postcode ambiguity probes.
 */
export const DIGIT_BOARD_FIXTURES = "packages/mailwoman/lib/eval-harness/fixtures/no-digits.jsonl"

export interface DigitFixture extends SpanBoardFixture {
	/**
	 * Present on the negative class: the parser must emit NO house_number, and MUST still emit the postcode.
	 */
	expect_no_house_number?: boolean
}

export type DigitBoardOptions = SpanBoardOptions

export type DigitBoardOutcome = SpanBoardOutcome

const tagText = (nodes: Array<{ tag: string; value: string; start: number }>, tag: string): string =>
	nodes
		.filter((n) => n.tag === tag)
		.toSorted((a, b) => a.start - b.start)
		.map((n) => n.value)
		.join(" ")

export async function runDigitBoard(options: DigitBoardOptions = {}): Promise<DigitBoardOutcome> {
	return runSpanBoard<DigitFixture>(
		{
			name: "digit board",
			defaultFixturesPath: DIGIT_BOARD_FIXTURES,
			headerLines: (fixtureCount) => [
				`\nNO digit-ownership board — ${fixtureCount} fixtures, Kartverket-derived, production config`,
				`95% Wilson intervals. bare-pc scores the ABSENCE of a house_number AND a surviving postcode.`,
				`bare-street-hn carries NO postcode — nothing competes for the digit.\n`,
			],
			grade: (fixture, nodes) => {
				const hn = tagText(nodes, "house_number")
				const pc = tagText(nodes, "postcode")

				// The negative class scores TWO things at once, because either failure is the same mistake:
				// the postcode must survive AND no house_number may be invented from it.
				const ok = fixture.expect_no_house_number
					? foldCaseWhitespace(hn) === "" &&
						foldCaseWhitespace(pc) === foldCaseWhitespace((fixture.expect.postcode ?? []).join(" "))
					: foldCaseWhitespace(hn) === foldCaseWhitespace((fixture.expect.house_number ?? []).join(" "))

				return { ok, got: fixture.expect_no_house_number ? `hn=${hn} pc=${pc}` : hn }
			},
			describeWant: (miss) =>
				miss.expect_no_house_number
					? `hn=(none) pc=${(miss.expect.postcode ?? []).join(" ")}`
					: (miss.expect.house_number ?? []).join(" "),
			missSampleSize: 5,
		},
		options
	)
}
