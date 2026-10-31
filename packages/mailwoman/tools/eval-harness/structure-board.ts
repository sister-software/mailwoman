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
export const STRUCTURE_BOARD_FIXTURES = dataRootPath("eval", "structure-heldout", "v2.jsonl").toString()

export type StructureBoardOptions = SpanBoardOptions

export type StructureBoardResult = SpanBoardResult

/**
 * A structure-board row.
 */
export interface StructureFixture extends SpanBoardFixture {
	/**
	 * When true, the row fails on any tag the parse emits that its expectation does not name.
	 *
	 * Query-shaped rows set it, so a category word tagged `street` or `region` fails in every class alike.
	 */
	strict?: boolean
	/**
	 * Other labelings that also pass, for a row whose tagging convention has no corpus precedent.
	 */
	alternatives?: Array<Record<string, string[]>>
}

interface GradedNode {
	tag: string
	value: string
	start: number
}

/**
 * Whether `nodes` match one expectation.
 *
 * Every expected tag must have exactly the expected text, and a tag listed empty must be absent.
 * In strict mode no other tag may appear.
 */
function matchesExpectation(expect: Record<string, string[]>, nodes: readonly GradedNode[], strict: boolean): boolean {
	for (const [tag, values] of Object.entries(expect)) {
		if (foldCaseWhitespace(tagText(nodes, tag)) !== foldCaseWhitespace(values.join(" "))) return false
	}

	return !strict || nodes.every((n) => n.tag in expect)
}

/**
 * Grades one structure-board row against its expectation and its alternatives.
 */
export function gradeStructureRow(
	fixture: StructureFixture,
	nodes: readonly GradedNode[]
): { ok: boolean; got: string } {
	// A fixture that keeps the whole street in `street` grades the parser's prefix and suffix spans as part of it.
	const splitsStreet = STREET_PARTS.some((tag) => tag !== "street" && tag in fixture.expect)
	const graded = splitsStreet ? nodes : nodes.map((n) => (STREET_PARTS.includes(n.tag) ? { ...n, tag: "street" } : n))

	const ok = [fixture.expect, ...(fixture.alternatives ?? [])].some((expect) =>
		matchesExpectation(expect, graded, fixture.strict === true)
	)

	const others = [...new Set(graded.map((n) => n.tag))].filter((tag) => !(tag in fixture.expect))

	return {
		ok,
		got: [
			...Object.keys(fixture.expect).map((tag) => `${tag}=${tagText(graded, tag) || "(none)"}`),
			...others.map((tag) => `+${tag}=${tagText(graded, tag)}`),
		].join(" "),
	}
}

const STREET_PARTS: readonly string[] = ["street_prefix", "street", "street_suffix"]

/**
 * Runs the structure board against its fixtures.
 */
export async function runStructureBoard(options: StructureBoardOptions = {}): Promise<StructureBoardResult> {
	return runSpanBoard<StructureFixture>(
		{
			name: "structure board",
			defaultFixturesPath: STRUCTURE_BOARD_FIXTURES,
			headerLines: (fixtureCount) => [
				`\nheld-out structure board: ${fixtureCount} fixtures`,
				`Parser with the query-shape prior and postcode repair; the kind classifier does not run.`,
				`A row passes when every expected tag matches and every tag listed empty is absent;`,
				`a strict row also fails on any other tag. 95% Wilson intervals.\n`,
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
