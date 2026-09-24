/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evaluate ownership of digit-containing tokens in Norwegian address fragments.
 *   Positive cases test house numbers; negative postcode cases require both postcode retention
 *   and no invented house number. Surfaces are split by normalized street name.
 *   Slash compounds remain one Norwegian component, unlike Australian unit/number forms.
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
	 * Present on the negative class: the parser must emit no house_number, and must still emit the postcode.
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

				// The negative class scores two things at once, because either failure is the same
				// mistake: the postcode must survive and no house_number may be invented from it.
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
