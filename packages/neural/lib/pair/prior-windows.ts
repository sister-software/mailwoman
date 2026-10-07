/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Candidate-window construction for the placetype-pair prior. It defines which token runs may stand as a child/parent pair,
 *   how segment boundaries and postcode shapes clip them, plus word-shape guards that keep a house number or a
 *   title preposition from opening a window. Split from `placetype-pair-prior.ts`, which owns the probing and the
 *   bias writes over the windows this module builds.
 */

import { PLZ_PATTERN } from "@mailwoman/codex/de"
import { CODIGO_POSTAL_PATTERN } from "@mailwoman/codex/es"
import { CODE_POSTAL_PATTERN } from "@mailwoman/codex/fr"
import { UK_POSTCODE_PATTERN } from "@mailwoman/codex/gb"
import { CAP_PATTERN } from "@mailwoman/codex/it"
import { NZ_POSTCODE_PATTERN } from "@mailwoman/codex/nz"

import type { WordGroup } from "#fst-prior"
import type { TokenLike } from "#query-shape-prior"

/**
 * P99 of the GB PPD `city` word-length distribution, where the observed register max was 5 words.
 */
export const WINDOW_MAX_WORDS = 3

/**
 * Anchored mode's child-window word cap, wider than {@link WINDOW_MAX_WORDS} because the
 * anchored geometry already excludes a venue phrase immediately left of the post-town anchor
 * and the observed register max was 5 words with a real 4-word class.
 */
export const ANCHORED_CHILD_MAX_WORDS = 4

/**
 * Bias magnitude used when neither the index nor the caller supplies one,
 * since real usage always has the artifact header's `index.delta`.
 */
export const DEFAULT_DELTA = 1

/**
 * Structural-marker words, where a candidate window immediately followed by one of these
 * is the head of a street or venue name rather than a standalone place reference.
 *
 * The set is deliberately partial.
 * Add an entry with its own rationale line, don't silently grow the set.
 */
export const STRUCTURAL_MARKER_WORDS: ReadonlySet<string> = new Set(["house", "road", "street", "flat", "court"])

/**
 * A bare house-number shape ("5", "12a", "104b"), where a window followed by this
 * shape reads as a numbered-street head rather than a place name.
 */
export function looksLikeHouseNumber(token: string): boolean {
	return /^\d+[a-z]?$/.test(token)
}

/**
 * Venue-title prepositions, where a word-group immediately preceding the child window that folds to
 * one of these withholds the transition adjustment for that hit while the emission bias stays as-is.
 *
 * An immediately preceding "at" or "of" marks a lexicalized venue title whose embedded
 * place name belongs to the venue's own name rather than an address field.
 * Address syntax introduces dependent localities positionally rather than prepositionally.
 *
 * Interior place-name prepositions ("Barrow upon Soar", "Knott End on Sea") are unaffected.
 * List growth requires a per-word rationale line.
 */
export const TITLE_PREPOSITION_PREDECESSORS: ReadonlySet<string> = new Set(["at", "of"])

/**
 * Whether the word-group immediately preceding `window` folds to a venue-title preposition.
 *
 * A window at position 0 has no predecessor and never suppresses.
 */
export function hasTitlePrepositionPredecessor(nonEmptyGroups: readonly WordGroup[], window: CandidateWindow): boolean {
	const predecessor = window.startPos > 0 ? nonEmptyGroups[window.startPos - 1] : undefined

	return predecessor !== undefined && TITLE_PREPOSITION_PREDECESSORS.has(predecessor.fstToken)
}

/**
 * A candidate, either a 1..{@link WINDOW_MAX_WORDS}-word sliding window or a whole comma-delimited segment.
 */
export interface CandidateWindow {
	/**
	 * The space-joined fold.
	 */
	key: string
	/**
	 * The bare-concatenation fold, identical to {@link key} for a single-word candidate.
	 */
	concatKey: string
	/**
	 * Inclusive position range within the filtered word-group list.
	 */
	startPos: number
	endPos: number
	pieceIndices: number[]
	/**
	 * The pieces the probe key covers when that range is narrower than {@link pieceIndices},
	 * as for a segment whose key had a same-field postcode stripped.
	 * Absent when the two coincide.
	 *
	 * The whole-edge parent write ({@link applyParentTagBias}) reads this field,
	 * while the child write spans the whole segment.
	 */
	keyPieceIndices?: number[]
}

/**
 * Build every contiguous 1..maxWords window over the non-punctuation word groups.
 */
export function buildWindows(nonEmptyGroups: readonly WordGroup[], maxWords: number): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	for (let start = 0; start < nonEmptyGroups.length; start++) {
		for (let len = 1; len <= maxWords && start + len <= nonEmptyGroups.length; len++) {
			const groups = nonEmptyGroups.slice(start, start + len)
			const tokens = groups.map((g) => g.fstToken)

			windows.push({
				key: tokens.join(" "),
				concatKey: tokens.join(""),
				startPos: start,
				endPos: start + len - 1,
				pieceIndices: groups.flatMap((g) => g.pieceIndices),
			})
		}
	}

	return windows
}

/**
 * Compute the segment index of every entry in `nonEmptyGroups`, by counting literal `,` and newline
 * characters in `inputText` that fall strictly before each group's first piece's start offset.
 *
 * Offset counts, rather than piece-text counts, are unaffected by how the tokenizer
 * attaches a piece to its neighboring word group.
 * Without `inputText`, every group falls in segment 0.
 */
export function computeGroupSegments(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): number[] {
	const boundaryOffsets: number[] = []

	if (inputText) {
		for (let i = 0; i < inputText.length; i++) {
			// A newline counts alongside the comma, because a postal address may put
			// the locality on its own line.
			if (inputText[i] === "," || inputText[i] === "\n") {
				boundaryOffsets.push(i)
			}
		}
	}

	// boundaryOffsets is built in ascending order, so `boundaryIdx` only ever
	// advances in one linear pass across both.
	let boundaryIdx = 0

	return nonEmptyGroups.map((group) => {
		const groupStart = pieces[group.pieceIndices[0]!]!.start

		while (boundaryIdx < boundaryOffsets.length && boundaryOffsets[boundaryIdx]! < groupStart) {
			boundaryIdx++
		}

		return boundaryIdx
	})
}

/**
 * Most trailing word-groups a segment-parent postcode strip removes.
 *
 * A GB postcode is at most two space-split word-groups and an NZ postcode is one.
 */
export const MAX_TRAILING_POSTCODE_WORDS = 2

/**
 * Per-country postcode shape used by the segment path's trailing-postcode strip,
 * keyed by the pair index header's lowercase ISO country.
 *
 * Each entry is the same anchored shape `@mailwoman/codex/<system>` owns, so the strip
 * and the postcode-repair and postcode-anchor passes never drift on what a GB or NZ postcode is.
 * A header country with no entry here produces no strip.
 *
 * Grow this map only with a real codex shape for the added country.
 */
export const SEGMENT_PARENT_POSTCODE_SHAPES: ReadonlyMap<string, RegExp> = new Map([
	["gb", UK_POSTCODE_PATTERN],
	["nz", NZ_POSTCODE_PATTERN],
	["fr", CODE_POSTAL_PATTERN],
	["de", PLZ_PATTERN],
	["es", CODIGO_POSTAL_PATTERN],
	["it", CAP_PATTERN],
])

/**
 * Countries whose postal convention writes the postcode before the locality on the same
 * line ("12210 Montpeyroux") rather than after it ("Macclesfield SK11 9PD").
 *
 * Membership is earned by a codex postcode shape plus a confound board
 * rather than by the country merely writing the postcode first.
 *
 * A country absent from this set is deliberate: en-IN is absent because the PIN goes last,
 * so the trailing-postcode strip already folds its parent segment correctly.
 */
export const LEADING_POSTCODE_COUNTRIES: ReadonlySet<string> = new Set(["fr", "de", "es", "it"])

/**
 * The trailing-postcode shape for the index's header country, or `null` when no shape is known.
 */
export function segmentParentPostcodeShape(country: string | null): RegExp | null {
	return country ? (SEGMENT_PARENT_POSTCODE_SHAPES.get(country.toLowerCase()) ?? null) : null
}

/**
 * Drop a trailing postcode-shaped run from a segment's fold tokens before it becomes a parent-candidate key.
 *
 * The guards: only a trailing run, the longest suffix of at most
 * {@link MAX_TRAILING_POSTCODE_WORDS} tokens whose bare concatenation full-matches `shape`
 * (longest-first so a two-token GB postcode strips whole), never the entire segment.
 * It strips a run only when `shape` is non-null.
 */
export function trailingSegmentPostcodeTake(tokens: readonly string[], shape: RegExp | null): number {
	if (shape === null || tokens.length < 2) return 0

	const maxTake = Math.min(tokens.length - 1, MAX_TRAILING_POSTCODE_WORDS)

	for (let take = maxTake; take >= 1; take--) {
		if (shape.test(tokens.slice(tokens.length - take).join(""))) return take
	}

	return 0
}

/**
 * Strip a leading postcode-shaped run from a segment's parent-candidate key, mirroring
 * {@link trailingSegmentPostcodeTake} for countries that write the postcode before the locality.
 *
 * The anchored full-match against the country shape means only a postcode for that country is removed.
 * Only the probe key changes.
 * The segment and every emitted span stay unchanged.
 */
export function leadingSegmentPostcodeTake(tokens: readonly string[], shape: RegExp | null): number {
	if (shape === null || tokens.length < 2) return 0

	const maxTake = Math.min(tokens.length - 1, MAX_TRAILING_POSTCODE_WORDS)

	for (let take = maxTake; take >= 1; take--) {
		if (shape.test(tokens.slice(0, take).join(""))) return take
	}

	return 0
}

/**
 * Build one candidate per comma-delimited segment of the input.
 *
 * Groups sharing a segment index are contiguous in `nonEmptyGroups`, so a single
 * forward pass over the precomputed `groupSegments` suffices.
 *
 * `parentPostcodeShape` strips a trailing postcode from the segment's key forms only,
 * while `startPos`, `endPos` and `pieceIndices` still span the whole segment.
 * The stripped range is recorded as {@link CandidateWindow.keyPieceIndices} for the whole-edge parent write.
 */
export function buildSegmentWindows(
	nonEmptyGroups: readonly WordGroup[],
	groupSegments: readonly number[],
	parentPostcodeShape: RegExp | null,
	leadingPostcodeShape: RegExp | null
): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	if (!nonEmptyGroups.length) return windows

	let segStart = 0

	for (let i = 1; i <= nonEmptyGroups.length; i++) {
		if (i === nonEmptyGroups.length || groupSegments[i] !== groupSegments[segStart]) {
			const groups = nonEmptyGroups.slice(segStart, i)

			// Both ends, because the postcode's position relative to the locality is a per-country
			// convention: "Macclesfield SK11 9PD" writes it last and "12210 Montpeyroux" writes it first.
			// Each strip is an anchored full-match against the country's own shape,
			// so a country that only writes one form is unaffected by the other pass.
			const tokens = groups.map((g) => g.fstToken)
			const trailTake = trailingSegmentPostcodeTake(tokens, parentPostcodeShape)
			const leadTake = leadingSegmentPostcodeTake(tokens.slice(0, tokens.length - trailTake), leadingPostcodeShape)
			const keyGroups = groups.slice(leadTake, groups.length - trailTake)
			const keyTokens = tokens.slice(leadTake, tokens.length - trailTake)

			windows.push({
				key: keyTokens.join(" "),
				concatKey: keyTokens.join(""),
				startPos: segStart,
				endPos: i - 1,
				pieceIndices: groups.flatMap((g) => g.pieceIndices),
				...(keyGroups.length === groups.length ? {} : { keyPieceIndices: keyGroups.flatMap((g) => g.pieceIndices) }),
			})

			segStart = i
		}
	}

	return windows
}

/**
 * Whether two windows' word-group position ranges do not overlap.
 * This also excludes a window from itself.
 */
export function disjoint(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.endPos < b.startPos || b.endPos < a.startPos
}

/**
 * Whether two candidates fold to an identical key under any of their fold forms.
 *
 * This is the identity test behind the repeated-name convention.
 *
 * Two different places collide here only when their folds collide,
 * since the same name text folds the same way.
 */
export function sharesFoldForm(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.key === b.key || a.key === b.concatKey || a.concatKey === b.key || a.concatKey === b.concatKey
}
