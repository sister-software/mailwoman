/**
 * Report-only predicates for the decoder-grammar census. These functions observe a completed decode; they do not score,
 * repair, or replace it.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import { PLACETYPE_TO_BIO, type FSTAcceptedMatch, type FSTPlaceEntryLike } from "@mailwoman/neural/fst-prior"

export interface CensusSpan {
	tag: string
	start: number
	end: number
}

export interface C6Violation {
	boundary: number
	left: CensusSpan
	right: CensusSpan
	covering: FSTAcceptedMatch
	nested: FSTAcceptedMatch
	nestedSide: "left" | "right"
	nestedEntries: FSTPlaceEntryLike[]
	coveringReferential: number | null
	nestedReferential: number
	referentialDelta: number | null
}

/**
 * C6: report a decoded boundary when a longer accepted registry surface covers it and a proper nested accepted surface
 * exactly aligns with either adjacent decoded span under the same component tag.
 */
export function detectC6Violations(
	spans: ReadonlyArray<CensusSpan>,
	matches: ReadonlyArray<FSTAcceptedMatch>
): C6Violation[] {
	const ordered = spans.toSorted((a, b) => a.start - b.start || a.end - b.end)
	const violations: C6Violation[] = []

	for (let index = 1; index < ordered.length; index++) {
		const left = ordered[index - 1]!
		const right = ordered[index]!

		if (left.end !== right.start) continue
		const boundary = left.end

		for (const covering of matches) {
			if (!(covering.startPiece < boundary && boundary < covering.endPiece)) continue

			for (const [nestedSide, span] of [
				["left", left],
				["right", right],
			] as const) {
				for (const nested of matches) {
					if (nested.startPiece !== span.start || nested.endPiece !== span.end) continue

					if (nested.startPiece <= covering.startPiece && nested.endPiece >= covering.endPiece) continue

					const nestedEntries = nested.entries.filter((entry) => PLACETYPE_TO_BIO.get(entry.placetype) === span.tag)

					if (!nestedEntries.length) continue

					const coveringScores = covering.entries
						.filter((entry) => PLACETYPE_TO_BIO.has(entry.placetype))
						.map((entry) => entry.referential)

					const coveringReferential = coveringScores.length ? Math.max(...coveringScores) : null
					const nestedReferential = Math.max(...nestedEntries.map((entry) => entry.referential))

					violations.push({
						boundary,
						left,
						right,
						covering,
						nested,
						nestedSide,
						nestedEntries,
						coveringReferential,
						nestedReferential,
						referentialDelta: coveringReferential === null ? null : coveringReferential - nestedReferential,
					})
				}
			}
		}
	}

	return violations
}

export type BoundaryTruthGrade = "true_positive" | "false_positive" | "unclassified"

export interface LocatedTruthSpan {
	tag: string
	value: string
	start: number
	end: number
}

/**
 * Locate only component truth that occurs exactly once in the input. Partial or repeated truth cannot determine whether
 * a detector firing is right and is deliberately omitted.
 */
export function locateUniqueComponentTruth(
	input: string,
	expected: Readonly<Record<string, string>>
): LocatedTruthSpan[] {
	const located: LocatedTruthSpan[] = []

	for (const [tag, value] of Object.entries(expected)) {
		const foldedValue = value.toLocaleLowerCase("und")
		const starts: number[] = []

		for (let start = 0; start + value.length <= input.length; start++) {
			if (input.slice(start, start + value.length).toLocaleLowerCase("und") === foldedValue) {
				starts.push(start)
			}
		}

		if (starts.length !== 1) continue
		const start = starts[0]!
		located.push({ tag, value, start, end: start + value.length })
	}

	return located
}

/**
 * Grade one reported boundary against partial component truth.
 *
 * A boundary inside a uniquely located expected component is a true positive. A boundary exactly on a uniquely located
 * expected component edge is a false positive unless another asserted component contains it. Everything else remains
 * unclassified rather than treating absent truth as negative truth.
 */
export function gradeBoundaryTruth(boundary: number, truth: ReadonlyArray<LocatedTruthSpan>): BoundaryTruthGrade {
	if (truth.some((span) => span.start < boundary && boundary < span.end)) return "true_positive"

	if (truth.some((span) => span.start === boundary || span.end === boundary)) return "false_positive"

	return "unclassified"
}

/**
 * Convert final BIO tokens to piece-index spans, the coordinate system used by {@link FSTAcceptedMatch}.
 */
export function spansFromBIO(tokens: ReadonlyArray<DecoderToken>): CensusSpan[] {
	const spans: CensusSpan[] = []

	for (let index = 0; index < tokens.length; index++) {
		const label = tokens[index]!.label

		if (label === "O") continue
		const separator = label.indexOf("-")
		const prefix = label.slice(0, separator)
		const tag = label.slice(separator + 1)
		const previous = spans.at(-1)

		if (prefix === "I" && previous?.tag === tag && previous.end === index) {
			previous.end = index + 1
		} else {
			spans.push({ tag, start: index, end: index + 1 })
		}
	}

	return spans
}

export interface RegistryScoreEntry {
	wofID: number
	placetype: string
	tag: string
	referential: number
}

export interface CompleteSpanRegistryReceipt {
	pieceCount: number
	covering: RegistryScoreEntry[]
	nested: Array<{ startPiece: number; endPiece: number; entries: RegistryScoreEntry[] }>
	bestCoveringReferential: number | null
	bestNestedReferential: number | null
	referentialDelta: number | null
}

function scoredEntries(entries: ReadonlyArray<FSTPlaceEntryLike>): RegistryScoreEntry[] {
	return entries.flatMap((entry) => {
		const tag = PLACETYPE_TO_BIO.get(entry.placetype)

		return tag ? [{ wofID: entry.wofID, placetype: entry.placetype, tag, referential: entry.referential }] : []
	})
}

/**
 * Compare BIO-mapped entries accepting the complete piece sequence with entries accepting any proper nested sequence.
 * Absence is `null`, never a score of zero.
 */
export function completeSpanRegistryReceipt(
	matches: ReadonlyArray<FSTAcceptedMatch>,
	pieceCount: number
): CompleteSpanRegistryReceipt {
	const covering = matches
		.filter((match) => match.startPiece === 0 && match.endPiece === pieceCount)
		.flatMap((match) => scoredEntries(match.entries))

	const nested = matches
		.filter((match) => match.startPiece > 0 || match.endPiece < pieceCount)
		.map((match) => ({ startPiece: match.startPiece, endPiece: match.endPiece, entries: scoredEntries(match.entries) }))
		.filter((match) => match.entries.length > 0)

	const coveringScores = covering.map((entry) => entry.referential)
	const nestedScores = nested.flatMap((match) => match.entries.map((entry) => entry.referential))
	const bestCoveringReferential = coveringScores.length ? Math.max(...coveringScores) : null
	const bestNestedReferential = nestedScores.length ? Math.max(...nestedScores) : null

	return {
		pieceCount,
		covering,
		nested,
		bestCoveringReferential,
		bestNestedReferential,
		referentialDelta:
			bestCoveringReferential === null || bestNestedReferential === null
				? null
				: bestCoveringReferential - bestNestedReferential,
	}
}

export interface C6RowReport {
	id: string
	input: string
	fstAvailable: boolean
	violations: Array<C6Violation & { boundaryCharacter: number; grade: BoundaryTruthGrade }>
	completeSpanRegistry?: CompleteSpanRegistryReceipt
	sourceGazetteer?: {
		databasePath: string
		key: string
		exactLocalities: Array<{ wofID: number; name: string; population: number | null; primary: boolean }>
		nestedLocalities: Array<{
			key: string
			rows: Array<{ wofID: number; name: string; population: number | null; primary: boolean }>
		}>
	}
}

export interface C6CensusSummary {
	rows: number
	rowsWithFST: number
	rowsFlagged: number
	boundariesFlagged: number
	truePositive: number
	falsePositive: number
	unclassified: number
}

/**
 * Aggregate row reports without treating rows lacking FST artifacts or component truth as negative examples.
 */
export function summarizeC6(rows: ReadonlyArray<C6RowReport>): C6CensusSummary {
	const violations = rows.flatMap((row) => row.violations)

	return {
		rows: rows.length,
		rowsWithFST: rows.filter((row) => row.fstAvailable).length,
		rowsFlagged: rows.filter((row) => row.violations.length > 0).length,
		boundariesFlagged: violations.length,
		truePositive: violations.filter((violation) => violation.grade === "true_positive").length,
		falsePositive: violations.filter((violation) => violation.grade === "false_positive").length,
		unclassified: violations.filter((violation) => violation.grade === "unclassified").length,
	}
}
