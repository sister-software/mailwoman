/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The locale fragment board: targeted failure classes with confidence intervals. This is the second
 *   of the two standing boards, the first being the global parity floor (`parity-corpus.ts`, broad,
 *   "do no harm").
 *
 *   A change ships when board 1 holds and board 2 moves. Neither board gives a verdict by itself. A single
 *   blended number can hide both a large gain on one class and the classes that paid for it.
 *
 *   Intervals matter because a small fixture (n=63) reports cells like 3/15. The 95% Wilson
 *   interval for 3/15 is roughly 4 to 48%. This board samples BAN (Tier A: clean, national, street-name
 *   complete) at roughly 400 per class so a cell means something. It prints the interval next to
 *   every number.
 *
 *   The negative class is the point. `bare-locality` rows include `expect_no_street`, and the board
 *   scores whether the parser emits a street anyway. Every other street harness in the repo filters
 *   to rows carrying `expect.street`, which makes a hallucinated street invisible by construction.
 *   A board that cannot score the failure cannot grade the fix.
 *
 *   Label policy: the full street phrase is `street`, with designator, particle, elision, hyphenated
 *   compound and date material included. `12 bis Rue X` gives house_number "12 bis" and street "Rue X".
 *
 *   Split: the fixture's street surfaces are reserved in `ban-fragments-fr.surfaces.txt`. A training
 *   database must exclude them by normalized street surface, since a row-level split leaks the surface
 *   across the boundary and measures memorization.
 */

import { STREET_FAMILY_TAGS } from "@mailwoman/codex/component"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import {
	runSpanBoard,
	type SpanBoardFixture,
	type SpanBoardOptions,
	type SpanBoardResult,
} from "#tools/eval-harness/span-board"

/**
 * Fixture set backing the fragment board, with bare-street and partial-address probes.
 */
export const FRAGMENT_BOARD_FIXTURES = "packages/mailwoman/tools/eval-harness/fixtures/ban-fragments-fr.jsonl"

/**
 * Tags that together form the street phrase under the board's label policy.
 */
const STREET_TAGS: ReadonlySet<string> = new Set(STREET_FAMILY_TAGS)

export interface FragmentFixture extends SpanBoardFixture {
	/**
	 * Present on the negative class: the parser must emit no street.
	 */
	expect_no_street?: boolean
}

export type FragmentBoardOptions = SpanBoardOptions

export type FragmentBoardResult = SpanBoardResult

export async function runFragmentBoard(options: FragmentBoardOptions = {}): Promise<FragmentBoardResult> {
	return runSpanBoard<FragmentFixture>(
		{
			name: "fragment board",
			defaultFixturesPath: FRAGMENT_BOARD_FIXTURES,
			headerLines: (fixtureCount) => [
				`\nFR locale fragment board — ${fixtureCount} fixtures, BAN (Tier A), production config`,
				`95% Wilson intervals. bare-locality scores the ABSENCE of a street (the hallucination class).\n`,
			],
			grade: (fixture, nodes) => {
				const street = nodes
					.filter((node) => STREET_TAGS.has(node.tag))
					.toSorted((a, b) => a.start - b.start)
					.map((node) => node.value)
					.join(" ")

				const ok = fixture.expect_no_street
					? foldCaseWhitespace(street) === ""
					: foldCaseWhitespace(street) === foldCaseWhitespace((fixture.expect.street ?? []).join(" "))

				return { ok, got: street }
			},
			describeWant: (miss) => (miss.expect_no_street ? "(no street)" : (miss.expect.street ?? []).join(" ")),
			missSampleSize: 6,
		},
		options
	)
}
