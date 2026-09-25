/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Board that checks whether the parser tags digits in Norwegian address fragments as a house number or a postcode.
 */

import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import {
	runSpanBoard,
	type SpanBoardFixture,
	type SpanBoardOptions,
	type SpanBoardOutcome,
} from "#eval-harness/span-board"

/**
 * Repository-relative path of the digit-board fixtures.
 */
export const DIGIT_BOARD_FIXTURES = "packages/mailwoman/lib/eval-harness/fixtures/no-digits.jsonl"

/**
 * Digit-board fixture.
 */
export interface DigitFixture extends SpanBoardFixture {
	/**
	 * Marks a negative row.
	 *
	 * The parser must emit the expected postcode and no house number.
	 */
	expect_no_house_number?: boolean
}

export type DigitBoardOptions = SpanBoardOptions

export type DigitBoardOutcome = SpanBoardOutcome

/**
 * Joins the values of every node with the given tag in input order.
 */
const tagText = (nodes: Array<{ tag: string; value: string; start: number }>, tag: string): string =>
	nodes
		.filter((n) => n.tag === tag)
		.toSorted((a, b) => a.start - b.start)
		.map((n) => n.value)
		.join(" ")

/**
 * Runs the digit board against its fixtures.
 */
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

				// A negative row passes only when the postcode survives and no house number is invented from it.
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
