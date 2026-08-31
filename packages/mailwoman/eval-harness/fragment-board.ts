/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The LOCALE FRAGMENT BOARD — targeted failure classes with confidence intervals (#727 stage-2,
 *   Tier 1c). The second of the two standing boards; the first is the global parity floor
 *   (`parity-corpus.ts`, broad, "do no harm").
 *
 *   A change ships when board 1 HOLDS and board 2 MOVES. Neither is a verdict alone. The span-head
 *   arc is the cautionary tale: +23.8pp on its target class and ~+0 net overall, which a single
 *   blended number turns into "inside noise, ship it" — hiding both the win and what it cost.
 *
 *   WHY INTERVALS. The Paris fixture (n=63) reports cells like 3/15. That has a 95% Wilson interval
 *   of roughly 4–48%: not a measurement, an anecdote with a decimal point. This board samples BAN
 *   (Tier A — clean, national, street-name complete) at ~400/class so a cell means something, and
 *   prints the interval next to every number so nobody has to remember that.
 *
 *   THE NEGATIVE CLASS IS THE POINT. `bare-locality` rows carry `expect_no_street`, and the board
 *   scores whether the parser emits a street anyway. Every other street harness in the repo filters
 *   to rows carrying `expect.street`, which makes a hallucinated street INVISIBLE BY CONSTRUCTION —
 *   and that is exactly where T1a caught the span decode failing (12/54 shipped vs 19/54). A board
 *   that cannot score the failure cannot grade the fix.
 *
 *   LABEL POLICY: the full street phrase is `street` — designator, particle, elision, hyphenated
 *   compound, and date material included. `12 bis Rue X` ⇒ house_number "12 bis", street "Rue X".
 *
 *   SPLIT: the fixture's street surfaces are reserved in `ban-fragments-fr.surfaces.txt`. A training
 *   shard MUST exclude them — source-disjoint by normalized street SURFACE, never by record row.
 *   Row-disjoint leaks the surface across the boundary and measures memorization.
 */

import { STREET_FAMILY_TAGS } from "@mailwoman/core/types"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import {
	runSpanBoard,
	type SpanBoardFixture,
	type SpanBoardOptions,
	type SpanBoardOutcome,
} from "#eval-harness/span-board"

export { wilson } from "#eval-harness/span-board"

/**
 * Fixture set backing the fragment board — bare-street and partial-address probes.
 */
export const FRAGMENT_BOARD_FIXTURES = "packages/mailwoman/eval-harness/fixtures/ban-fragments-fr.jsonl"

/**
 * Tags that together form the street phrase under the board's label policy.
 */
const STREET_TAGS: ReadonlySet<string> = new Set(STREET_FAMILY_TAGS)

export interface FragmentFixture extends SpanBoardFixture {
	/**
	 * Present on the negative class: the parser must emit NO street.
	 */
	expect_no_street?: boolean
}

export type FragmentBoardOptions = SpanBoardOptions

export type FragmentBoardOutcome = SpanBoardOutcome

export async function runFragmentBoard(options: FragmentBoardOptions = {}): Promise<FragmentBoardOutcome> {
	return runSpanBoard<FragmentFixture>(
		{
			name: "fragment board",
			defaultFixturesPath: FRAGMENT_BOARD_FIXTURES,
			headerLines: (fixtureCount) => [
				`\nFR locale fragment board — ${fixtureCount} fixtures, BAN (Tier A), production config`,
				`95% Wilson intervals. bare-locality scores the ABSENCE of a street (the hallucination class).\n`,
			],
			// hit = the scored assertion held. For positive classes that is street exact-match; for the
			// negative class it is the ABSENCE of a street.
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
