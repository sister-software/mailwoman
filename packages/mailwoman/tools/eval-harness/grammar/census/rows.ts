// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The rows a report-only decode census reads, with their truth.
 *
 * A census reads an input list, held-out collections, or the Gauntlet board.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"
import { locateUniqueComponentTruth, type TruthSpan } from "#tools/eval-harness/grammar/census"
import { readHeldoutCollectionRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { heldoutRowID } from "#tools/eval-harness/heldout/per/country"

export interface DecodeCensusRow {
	collection: string
	id: string
	input: string
	country: string | null
	/**
	 * Character truth against `input`, or the board's component values located in the parsed text.
	 */
	truth: { spans: TruthSpan[]; complete: true } | { components: Record<string, string>; complete: false }
}

export interface CensusRowSource {
	/**
	 * Held-out dataset manifests, read in order.
	 */
	heldout?: readonly string[]
	/**
	 * A file of one input per line, parsed through the base route with no truth.
	 */
	inputs?: string
}

/**
 * Yields the rows of `inputs` when given, else of the `heldout` manifests, else of the Gauntlet board.
 */
export async function* readDecodeCensusRows(source: CensusRowSource): AsyncGenerator<DecodeCensusRow> {
	const manifests = source.heldout ?? []

	if (source.inputs) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- A hand-written probe list of a few dozen lines.
		for (const input of (await readLocalTextFile(source.inputs)).split("\n").filter((line) => line.trim())) {
			yield { collection: "inputs", id: input, input, country: null, truth: { components: {}, complete: false } }
		}

		return
	}

	if (!manifests.length) {
		for (const row of await loadRegressionCases()) {
			yield {
				collection: "board",
				id: row.id,
				input: row.input,
				country: row.locale?.split("-")[1] ?? row.country,
				truth: { components: row.expectComponents ?? {}, complete: false },
			}
		}

		return
	}

	for await (const { collection, row } of readHeldoutCollectionRows(manifests)) {
		yield {
			collection,
			id: heldoutRowID(row),
			input: row.raw,
			country: row.country,
			truth: {
				spans: row.span_tags.map((tag, span) => ({
					tag,
					start: row.span_starts[span]!,
					end: row.span_ends[span]!,
				})),
				complete: true,
			},
		}
	}
}

/**
 * Truth in the parsed text's coordinates.
 *
 * Held-out character truth is used as given only when the parsed text is the input up to case.
 */
export function truthInText(row: DecodeCensusRow, text: string): { spans: TruthSpan[]; complete: boolean } {
	if (!row.truth.complete) {
		return { spans: locateUniqueComponentTruth(text, row.truth.components), complete: false }
	}

	if (text.length === row.input.length && text.toLowerCase() === row.input.toLowerCase()) {
		return { spans: row.truth.spans, complete: true }
	}

	const components: Record<string, string> = {}

	for (const span of row.truth.spans) {
		components[`${span.tag}\u0000${span.start}`] = row.input.slice(span.start, span.end)
	}

	return {
		spans: locateUniqueComponentTruth(text, components).map((span) => ({
			...span,
			tag: span.tag.split("\u0000")[0]!,
		})),
		complete: false,
	}
}
