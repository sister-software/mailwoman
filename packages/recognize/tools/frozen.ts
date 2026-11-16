// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The frozen output of the legacy structural classifier, and the comparison with it.
 *
 *   `data/fixtures/query-shape-frozen.json` holds the output of `computeQueryShape` from the
 *   `@mailwoman/query-shape` package, taken before that package was deleted: the 78 golden inputs,
 *   29 inputs for the legacy behaviors that look accidental, 500 generated inputs over every
 *   character class the generator lists, 500 generated inputs dense in postcode shapes
 *   and PO box leaders, 670 inputs drawn from the gauntlet cases (every second input,
 *   in sorted order, of the 1,339 distinct inputs under the two-letter country directories),
 *   and the class and script of every Unicode codepoint as runs.
 *   The gauntlet inputs are committed in this repository, so the fixture holds no row from the data root.
 *
 *   A case records the six structural fields and `knownFormats`.
 *   The fixture's own `draw` field records how each part was drawn.
 *
 *   The structure test in this package and the known-formats test in `@mailwoman/postcode`
 *   compare the recognizer's output with it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"

import type { KnownFormatHit, StructureFields } from "#types"

/**
 * The six structural fields, as plain data.
 */
export type FrozenStructure = {
	[Key in keyof StructureFields]: StructureFields[Key] extends readonly unknown[]
		? Array<Record<string, unknown>>
		: StructureFields[Key]
}

/**
 * One frozen case: an input and the output the legacy classifier returned for it.
 */
export interface FrozenCase {
	category: string
	input: string
	fields: FrozenStructure & { knownFormats: Array<KnownFormatHit> }
}

/**
 * The fixture file.
 */
export interface FrozenFixture {
	description: string
	draw: Record<string, unknown>
	/**
	 * Runs of codepoints with one key: `[first, last, key]`.
	 */
	codepointRuns: Array<[number, number, string]>
	cases: FrozenCase[]
}

/**
 * Reads the frozen fixture.
 */
export async function readFrozenFixture(): Promise<FrozenFixture> {
	return readLocalJSONFile<FrozenFixture>(
		workspacePath("recognize", "data", "fixtures", "query-shape-frozen.json").toString()
	)
}

/**
 * The key of a codepoint's run, from the fields of the one-codepoint text.
 */
export function codepointKey(
	fields: Pick<StructureFields, "characterClass" | "scripts" | "tokenClasses" | "segments"> & {
		knownFormats: readonly unknown[]
	}
): string {
	const token = fields.tokenClasses[0]

	return `${fields.characterClass}|${token ? `${token.class}|${token.script}` : "none"}|${fields.scripts[0]?.script ?? "none"}|${fields.segments.length}|${fields.knownFormats.length}`
}

/**
 * The fields as plain data in a fixed key order, so two equal values print equal.
 */
export function plainFields(
	fields: StructureFields & { knownFormats?: readonly KnownFormatHit[] }
): FrozenCase["fields"] {
	return {
		characterClass: fields.characterClass,
		scripts: fields.scripts.map(({ script, share }) => ({ script, share })),
		tokenClasses: fields.tokenClasses.map(({ span, class: tokenClass, script }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			class: tokenClass,
			script,
		})),
		segments: fields.segments.map(({ span, body, index, separator }) => ({
			span: { start: span.start, end: span.end, body: span.body },
			body,
			index,
			separator,
		})),
		regionAbbreviations: fields.regionAbbreviations.map(({ start, span }) => ({ start, span })),
		totalLength: fields.totalLength,
		knownFormats: (fields.knownFormats ?? []).map(({ format, span, confidence }) => ({
			format,
			span: { start: span.start, end: span.end, body: span.body },
			confidence,
		})),
	}
}
