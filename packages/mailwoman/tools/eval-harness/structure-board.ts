/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Board that checks whether the parser labels held-out address shapes it was not trained on: WOF structure cells kept
 *   out of every training arm, query shapes, relation-word pairs, mixed-script venues, romaji in Western order and typos
 *   (#2857, step 5).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"

import {
	runSpanBoard,
	type SpanBoardFixture,
	type SpanBoardOptions,
	type SpanBoardResult,
	tagText,
} from "#tools/eval-harness/span-board"

/**
 * Path of the structure-board fixtures on the data root.
 *
 * The file is assembled from the held-out cells a WOF build writes and from
 * handwritten rows, and its sha256 is recorded on #2857.
 */
export const STRUCTURE_BOARD_FIXTURES = dataRootPath("eval", "structure-heldout", "v1.jsonl").toString()

export type StructureBoardOptions = SpanBoardOptions

export type StructureBoardResult = SpanBoardResult

/**
 * Whether the parse labels every expected tag with exactly the expected text,
 * and emits no tag the fixture lists as empty.
 * Tags the fixture does not name are not graded.
 */
export function gradeStructureRow(
	fixture: SpanBoardFixture,
	nodes: ReadonlyArray<{ tag: string; value: string; start: number }>
): { ok: boolean; got: string } {
	// A fixture that keeps the whole street in `street` grades the parser's prefix and suffix spans as part of it.
	const splitsStreet = STREET_PARTS.some((tag) => tag !== "street" && tag in fixture.expect)
	const graded = splitsStreet ? nodes : nodes.map((n) => (STREET_PARTS.includes(n.tag) ? { ...n, tag: "street" } : n))
	const got: Record<string, string> = {}
	let ok = true

	for (const [tag, values] of Object.entries(fixture.expect)) {
		const text = tagText(graded, tag)

		got[tag] = text

		if (foldCaseWhitespace(text) !== foldCaseWhitespace(values.join(" "))) {
			ok = false
		}
	}

	const others = [...new Set(graded.map((n) => n.tag))].filter((tag) => !(tag in fixture.expect))

	return {
		ok,
		got: [
			...Object.entries(got).map(([tag, text]) => `${tag}=${text || "(none)"}`),
			...others.map((tag) => `+${tag}=${tagText(graded, tag)}`),
		].join(" "),
	}
}

const STREET_PARTS: readonly string[] = ["street_prefix", "street", "street_suffix"]

/**
 * Runs the structure board against its fixtures.
 */
export async function runStructureBoard(options: StructureBoardOptions = {}): Promise<StructureBoardResult> {
	return runSpanBoard<SpanBoardFixture>(
		{
			name: "structure board",
			defaultFixturesPath: STRUCTURE_BOARD_FIXTURES,
			headerLines: (fixtureCount) => [
				`\nheld-out structure board: ${fixtureCount} fixtures, production config`,
				`A row passes when every expected tag matches and every tag listed empty is absent. 95% Wilson intervals.\n`,
			],
			grade: gradeStructureRow,
			describeWant: (fixture) =>
				Object.entries(fixture.expect)
					.map(([tag, values]) => `${tag}=${values.join(" ") || "(none)"}`)
					.join(" "),
			missSampleSize: 8,
		},
		options
	)
}
