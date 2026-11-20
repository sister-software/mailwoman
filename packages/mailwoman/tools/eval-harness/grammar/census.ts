// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Report-only predicates for the decoder-grammar census.
 *
 * These functions observe a completed decode.
 * They do not score, repair, or replace it.
 */

import { bareBIOTag } from "@mailwoman/codex/component"
import type { DecoderToken } from "@mailwoman/core/decoder"
import type { DecodeExplanation } from "@mailwoman/neural/decode-explanation"
import {
	groupPiecesIntoWords,
	isStreetShapedSurface,
	PLACETYPE_TO_BIO,
	type FSTAcceptedMatch,
	type FSTMatcherLike,
	type FSTPlaceEntryLike,
} from "@mailwoman/neural/fst-prior"
import { softmax } from "@mailwoman/neural/viterbi"

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
 * The indices of outside pieces whose text is empty or whitespace.
 *
 * The tokenizer can emit a bare `▁` piece before a digit or a script change.
 * The decoder labels it `O`, which leaves a one-piece gap between two spans written next
 * to each other. {@linkcode adjacentSpanPairs} treats such a gap as no gap.
 */
export function blankOutsidePieces(
	tokens: ReadonlyArray<Pick<DecoderToken, "start" | "end"> & { label: string }>,
	text: string
): Set<number> {
	const blank = new Set<number>()

	for (const [index, token] of tokens.entries()) {
		if (token.label === "O" && !text.slice(token.start, token.end).trim()) {
			blank.add(index)
		}
	}

	return blank
}

/**
 * Each pair of decoded spans whose gap holds only blank outside pieces, in input order.
 */
export function adjacentSpanPairs(
	spans: ReadonlyArray<CensusSpan>,
	blankPieces: ReadonlySet<number> = new Set()
): Array<[left: CensusSpan, right: CensusSpan]> {
	const ordered = spans.toSorted((a, b) => a.start - b.start || a.end - b.end)
	const pairs: Array<[CensusSpan, CensusSpan]> = []

	for (let index = 1; index < ordered.length; index++) {
		const left = ordered[index - 1]!
		const right = ordered[index]!

		if (left.end > right.start) continue

		let gapIsBlank = true

		for (let piece = left.end; piece < right.start; piece++) {
			if (!blankPieces.has(piece)) {
				gapIsBlank = false
			}
		}

		if (gapIsBlank) {
			pairs.push([left, right])
		}
	}

	return pairs
}

/**
 * C6: report a decoded boundary when a longer accepted registry surface covers it and a proper nested
 * accepted surface exactly aligns with either adjacent decoded span under the same component tag.
 *
 * The boundary is the right span's first piece.
 * Spans separated only by `blankPieces` count as adjacent.
 */
export function detectC6Violations(
	spans: ReadonlyArray<CensusSpan>,
	matches: ReadonlyArray<FSTAcceptedMatch>,
	blankPieces: ReadonlySet<number> = new Set()
): C6Violation[] {
	const violations: C6Violation[] = []

	for (const [left, right] of adjacentSpanPairs(spans, blankPieces)) {
		const boundary = right.start

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
 * Locate only component truth that occurs exactly once in the input.
 *
 * Partial or repeated truth cannot determine whether a detector firing is right and is deliberately omitted.
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
 * A boundary inside a uniquely located expected component is a true positive.
 * A boundary exactly on a uniquely located expected component edge is a false positive
 * unless another asserted component contains it.
 *
 * Everything else remains unclassified rather than treating absent truth as negative truth.
 */
export function gradeBoundaryTruth(boundary: number, truth: ReadonlyArray<LocatedTruthSpan>): BoundaryTruthGrade {
	if (truth.some((span) => span.start < boundary && boundary < span.end)) return "true_positive"

	if (truth.some((span) => span.start === boundary || span.end === boundary)) return "false_positive"

	return "unclassified"
}

/**
 * Convert final BIO tokens to piece-index spans, the coordinate system used by {@link FSTAcceptedMatch}.
 */
export function spansFromBIO(tokens: ReadonlyArray<{ label: string }>): CensusSpan[] {
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
 * Compare BIO-mapped entries accepting the complete piece sequence with entries
 * accepting any proper nested sequence.
 *
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
		.filter((match) => match.entries.length)

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
	completeSpanRegistry: CompleteSpanRegistryReceipt | null
	sourceGazetteer: {
		databasePath: string
		key: string
		exactLocalities: Array<{ wofID: number; name: string; population: number | null; primary: boolean }>
		nestedLocalities: Array<{
			key: string
			rows: Array<{ wofID: number; name: string; population: number | null; primary: boolean }>
		}>
	} | null
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
		rowsFlagged: rows.filter((row) => row.violations.length).length,
		boundariesFlagged: violations.length,
		truePositive: violations.filter((violation) => violation.grade === "true_positive").length,
		falsePositive: violations.filter((violation) => violation.grade === "false_positive").length,
		unclassified: violations.filter((violation) => violation.grade === "unclassified").length,
	}
}

/**
 * A run of contiguous pieces the decoder labels differently when the FST prior
 * is removed and every other term is kept.
 */
export interface FSTFlipSpan {
	startPiece: number
	endPiece: number
	/**
	 * The tag decoded with the FST prior.
	 */
	withFST: string
	/**
	 * The tag decoded without it.
	 */
	withoutFST: string
}

/**
 * Groups the FST ledger entry's changed pieces into runs that share one tag pair.
 *
 * Null when the parse has no explanation, because absent evidence isn't an empty flip set.
 * A run whose two tags are equal changed only a span boundary.
 */
export function fstFlipSpans(explanation: DecodeExplanation | null): FSTFlipSpan[] | null {
	if (!explanation) return null

	const changes = explanation.ledger.find((entry) => entry.prior === "fst")?.changes ?? []
	const spans: FSTFlipSpan[] = []

	for (const change of changes.toSorted((a, b) => a.piece - b.piece)) {
		const withFST = bareBIOTag(change.from)
		const withoutFST = bareBIOTag(change.to)
		const previous = spans.at(-1)

		if (
			previous?.endPiece === change.piece &&
			previous.withFST === withFST &&
			previous.withoutFST === withoutFST &&
			!change.from.startsWith("B-")
		) {
			previous.endPiece = change.piece + 1
		} else {
			spans.push({ startPiece: change.piece, endPiece: change.piece + 1, withFST, withoutFST })
		}
	}

	return spans
}

/**
 * One FST entry that biases a tag at one accepted match.
 */
export interface FSTVote {
	entry: FSTPlaceEntryLike
	tag: string
	startPiece: number
	endPiece: number
}

/**
 * Replays which entry votes at which match, under the attribution rules of
 * `buildFSTEmissionPriors`: each WOF id votes only at the first match that reaches it,
 * an entry votes for its {@linkcode PLACETYPE_TO_BIO} tag, and the mapped `localadmin`
 * and `neighbourhood` tiers don't vote on a street-shaped surface.
 *
 * It reads `PLACETYPE_TO_BIO` at call time and ignores the street-context and anchor-region scales.
 * Those scales set a vote's size and not which entry votes.
 */
export function fstVotes(
	matches: ReadonlyArray<FSTAcceptedMatch>,
	pieces: ReadonlyArray<{ piece: string }>
): FSTVote[] {
	const groups = groupPiecesIntoWords(pieces)
	const seen = new Set<number>()
	const votes: FSTVote[] = []

	for (const match of matches) {
		const surface = groups
			.slice(match.startWord, match.endWord)
			.filter((group) => group.fstToken !== "")
			.map((group) => group.fstToken)

		const streetShaped = isStreetShapedSurface(surface)

		for (const entry of match.entries) {
			if (seen.has(entry.wofID)) continue
			seen.add(entry.wofID)
			const tag = PLACETYPE_TO_BIO.get(entry.placetype)

			if (!tag) continue

			if (streetShaped && (entry.placetype === "localadmin" || entry.placetype === "neighbourhood")) continue

			votes.push({ entry, tag, startPiece: match.startPiece, endPiece: match.endPiece })
		}
	}

	return votes
}

/**
 * The vote with the highest referential for `tag` among the votes whose match overlaps
 * the pieces, and the count of votes for `tag` that overlap them.
 *
 * The bias on a piece is the maximum over its votes, so this entry sets it
 * unless a context scale shrank its match.
 * Compare with the ledger's cell to tell.
 */
export function maximumVote(
	votes: ReadonlyArray<FSTVote>,
	tag: string,
	startPiece: number,
	endPiece: number
): { vote: FSTVote | null; count: number } {
	const covering = votes.filter((vote) => vote.tag === tag && vote.startPiece < endPiece && vote.endPiece > startPiece)

	let best: FSTVote | null = null

	for (const vote of covering) {
		if (!best || vote.entry.referential > best.entry.referential) {
			best = vote
		}
	}

	return { vote: best, count: covering.length }
}

/**
 * The largest FST emission change on the `B-` or `I-` label of `tag` over the pieces,
 * read from the decode explanation's ledger, or null when the FST changed none of those cells.
 */
export function fstBiasOn(
	explanation: DecodeExplanation | null,
	tag: string,
	startPiece: number,
	endPiece: number
): number | null {
	const cells = explanation?.ledger.find((entry) => entry.prior === "fst")?.cells ?? []
	let best: number | null = null

	for (const cell of cells) {
		if (cell.piece < startPiece || cell.piece >= endPiece) continue

		if (cell.label !== `B-${tag}` && cell.label !== `I-${tag}`) continue

		if (best === null || cell.delta > best) {
			best = cell.delta
		}
	}

	return best
}

/**
 * The locale head's reading: its top country, that country's probability, and every country's probability.
 */
export interface LocaleHeadReading {
	country: string
	confidence: number
	probabilities: Record<string, number>
}

/**
 * Reads the locale head's softmax, or null for a model without the head.
 */
export function localeHeadReading(
	localeLogits: readonly number[] | null,
	localeCountries: readonly string[] | null
): LocaleHeadReading | null {
	if (!localeLogits || !localeCountries || localeLogits.length !== localeCountries.length) return null

	const softmaxed = softmax(localeLogits)
	const probabilities: Record<string, number> = {}
	let country = localeCountries[0]!
	let confidence = -1

	for (const [index, code] of localeCountries.entries()) {
		const probability = softmaxed[index]!
		probabilities[code] = probability

		if (probability > confidence) {
			confidence = probability
			country = code
		}
	}

	return { country, confidence, probabilities }
}

/**
 * A character span of component truth.
 */
export type TruthSpan = Pick<LocatedTruthSpan, "tag" | "start" | "end">

/**
 * The truth tag over a character range: the tag of the one truth span it overlaps.
 *
 * With `complete` truth, a range that overlaps none is `O`.
 * Partial truth leaves it null, as it leaves a range that overlaps two spans.
 */
export function truthTagForRange(
	truth: ReadonlyArray<TruthSpan>,
	start: number,
	end: number,
	complete: boolean
): string | null {
	const overlapping = truth.filter((span) => span.start < end && span.end > start)

	if (overlapping.length === 1) return overlapping[0]!.tag

	if (!overlapping.length && complete) return "O"

	return null
}

/**
 * Whether the FST's change moved a span toward the truth tag, away from it, or neither.
 */
export type FlipGrade = "helped" | "hurt" | "neither" | "unclassified"

export function gradeFlip(withFST: string, withoutFST: string, truthTag: string | null): FlipGrade {
	if (truthTag === null) return "unclassified"

	if (withFST === truthTag && withoutFST !== truthTag) return "helped"

	if (withoutFST === truthTag && withFST !== truthTag) return "hurt"

	return "neither"
}

/**
 * The truth tag of each piece with word content, null for a blank piece or ungraded truth.
 */
export function pieceTruthTags(
	pieces: ReadonlyArray<{ start: number; end: number }>,
	text: string,
	truth: ReadonlyArray<TruthSpan>,
	complete: boolean
): Array<string | null> {
	return pieces.map((piece) =>
		text.slice(piece.start, piece.end).trim() ? truthTagForRange(truth, piece.start, piece.end, complete) : null
	)
}

/**
 * How a second decode of one row differs from the first against piece truth.
 */
export interface PathMove {
	/**
	 * The pieces whose tag differs between the two decodes.
	 */
	changedPieces: number[]
	/**
	 * Changed pieces the second decode tags as the truth does and the first doesn't.
	 */
	gained: number
	/**
	 * Changed pieces the first decode tags as the truth does and the second doesn't.
	 */
	lost: number
}

export function comparePaths(
	first: readonly string[],
	second: readonly string[],
	truth: ReadonlyArray<string | null>
): PathMove {
	const changedPieces: number[] = []
	let gained = 0
	let lost = 0

	for (const [index, label] of first.entries()) {
		const before = bareBIOTag(label)
		const after = bareBIOTag(second[index] ?? "O")

		if (before === after) continue
		changedPieces.push(index)
		const expected = truth[index]

		if (expected == null) continue

		if (after === expected) {
			gained++
		} else if (before === expected) {
			lost++
		}
	}

	return { changedPieces, gained, lost }
}

/**
 * Wraps an FST matcher so every accepting state returns `transform` of its entries.
 *
 * The walk is unchanged, so only which entries vote and with what referential can differ.
 */
export function transformFSTEntries(
	fst: FSTMatcherLike,
	transform: (entries: FSTPlaceEntryLike[]) => FSTPlaceEntryLike[]
): FSTMatcherLike {
	return {
		walk: (tokens) => fst.walk(tokens),
		walkFrom: (previous, token) => fst.walkFrom(previous, token),
		accepting: (stateID) => transform(fst.accepting(stateID)),
	}
}
