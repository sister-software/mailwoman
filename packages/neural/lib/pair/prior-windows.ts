/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Candidate-window construction for the placetype-pair prior: which token runs may stand as a child/parent pair,
 *   how segment boundaries and postcode shapes clip them, and the word-shape guards that keep a house number or a
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
 * P99 of the GB PPD `CITY` word-length distribution (measured 2026-07-22; see the module docstring's table). A
 * dependent_locality-shaped candidate almost never spans more than 3 words in the source register that motivated this
 * prior; the observed max was 5 (287 of 9,031,691 rows).
 */
export const WINDOW_MAX_WORDS = 3

/**
 * Anchored mode's child-window word cap. Wider than {@link WINDOW_MAX_WORDS} on purpose: the anchored geometry already
 * rejects the venue-confound class by construction (a venue phrase is never immediately left of the post-town anchor),
 * so the over-matching risk that froze the sliding-window cap at the p99 doesn't apply, and the observed register max
 * is 5 words with a real 4-word class ("Knott End on Sea"). Segment/window modes keep their own caps unchanged.
 */
export const ANCHORED_CHILD_MAX_WORDS = 4

/**
 * Bias magnitude used when neither the index nor the caller supplies one. Real usage always has `index.delta` (the
 * calibrated per-country delta from the artifact header, 5.0 for GB as of the 2026-07-22 calibration), so this is a
 * defensive fallback, not a tuned value.
 */
export const DEFAULT_DELTA = 1

/**
 * Structural-marker words: a candidate window immediately followed by one of these is the HEAD of a street/venue name,
 * not a standalone place reference. Each entry's rationale is the specific false-positive class it closes (the rung-3
 * venue-confound board):
 *
 * - `house` — venue/building-name suffix: "Church House", "Manor House".
 * - `road` / `street` — street-type suffix: "Church Road", "Church Street".
 * - `flat` — unit designator following a street/venue head: "Church Flat 2".
 * - `court` — venue/building-name suffix (also a common street-type in some registers): "Church Court".
 *
 * Not exhaustive by design — this closes the specific classes the rung-3 evidence surfaced, not every conceivable
 * street/venue suffix. Widening the table is a future tunable (same discipline as `fst-prior.ts`'s length-scaling
 * knobs): add an entry with its own rationale line, don't silently grow the set.
 */
export const STRUCTURAL_MARKER_WORDS: ReadonlySet<string> = new Set(["house", "road", "street", "flat", "court"])

/**
 * A bare house-number shape ("5", "12a", "104b") — the successor CLASS the marker table's rationale calls out alongside
 * the fixed word list: a window followed by what looks like a house number reads as a numbered-street head ("Church
 * 5"-style patterns in some registers), not a place name. Same suppression rationale as the fixed words, expressed as a
 * shape test instead of a literal set (a house number is not enumerable).
 */
export function looksLikeHouseNumber(token: string): boolean {
	return /^\d+[a-z]?$/.test(token)
}

/**
 * Venue-title prepositions (BETA REFINEMENT, 2026-07-24 — v2 battery bar-2 regression): when the word-group immediately
 * PRECEDING the child window folds to one of these, the TRANSITION adjustment (TRANSITION-BETA) is withheld for that
 * hit — the EMISSION bias stays exactly as-is. Rationale: an immediately-preceding "at"/"of" marks a LEXICALIZED venue
 * title ("New Inn at Hoff", "Church of St Mary") — the embedded place name is part of the venue's own name, not an
 * address field. Address syntax introduces dependent localities POSITIONALLY (field order, adjacency to the post town),
 * never prepositionally, so a prepositional predecessor is venue-title evidence and the entry-path bonus must not tip a
 * near-miss into a false positive (the measured trigger: "New Inn at Hoff, Appleby-In-Westmorland" — the β=5 entry
 * bonus alone flipped it, failing the venue-anchored ≤4/6500 bar by one row). Interior place-name prepositions ("Barrow
 * upon Soar", "Knott End on Sea") are unaffected by construction — this is a PREDECESSOR check, not a membership test
 * on the child's own words. No predecessor (child at the string/segment start) → no suppression. LIST GROWTH requires a
 * per-word rationale line (the same widening discipline as {@link STRUCTURAL_MARKER_WORDS}); long-term the list derives
 * from register statistics (#1296).
 *
 * - `at` — venue-title locative: "New Inn at Hoff", "The Mill at Glynhir".
 * - `of` — venue-title genitive: "Church of St Mary", "House of Bruar".
 */
export const TITLE_PREPOSITION_PREDECESSORS: ReadonlySet<string> = new Set(["at", "of"])

/**
 * Is the word-group immediately preceding `window` a venue-title preposition (see
 * {@link TITLE_PREPOSITION_PREDECESSORS})? A window at position 0 has no predecessor and never suppresses.
 */
export function hasTitlePrepositionPredecessor(nonEmptyGroups: readonly WordGroup[], window: CandidateWindow): boolean {
	const predecessor = window.startPos > 0 ? nonEmptyGroups[window.startPos - 1] : undefined

	return predecessor !== undefined && TITLE_PREPOSITION_PREDECESSORS.has(predecessor.fstToken)
}

/**
 * A candidate — either a 1..{@link WINDOW_MAX_WORDS}-word sliding window (window mode) or a whole comma-delimited
 * segment (segment mode).
 */
export interface CandidateWindow {
	/**
	 * The space-joined fold — see the module docstring's "St Helens" → "st helens" note.
	 */
	key: string
	/**
	 * The bare-concatenation fold (no separator) — see the module docstring's "dual-key probe" note. Identical to
	 * {@link key} for a single-word candidate; only diverges for a genuine multi-word one.
	 */
	concatKey: string
	/**
	 * Inclusive position range within the FILTERED (non-punctuation) word-group list — used for the disjointness check
	 * and to locate the immediately-following word for marker suppression.
	 */
	startPos: number
	endPos: number
	pieceIndices: number[]
	/**
	 * The pieces the probe KEY actually covers, when that is narrower than {@link pieceIndices} — i.e. a segment whose key
	 * had a same-field postcode stripped (#1308 / the leading-postcode countries). Absent when the two coincide.
	 *
	 * Read ONLY by the whole-edge parent write ({@link applyParentTagBias}). The child write deliberately keeps spanning
	 * the whole segment, which is what it has always done. The distinction is not cosmetic: a French parent segment is
	 * "12210 Montpeyroux", the key is "montpeyroux", and biasing the whole segment toward `locality` emits `locality =
	 * "12210 Montpeyroux"` — postcode included. Measured on `fr-lieudit-golden.jsonl`: whole-edge 96.3% → 0.0% at
	 * parentDelta ≥ 6 before this field existed, with the child still correct on 77/80.
	 */
	keyPieceIndices?: number[]
}

/**
 * Build every contiguous 1..maxWords window over the non-punctuation word groups (window mode).
 */
export function buildWindows(nonEmptyGroups: readonly WordGroup[], maxWords: number): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	for (let start = 0; start < nonEmptyGroups.length; start++) {
		for (let len = 1; len <= maxWords && start + len <= nonEmptyGroups.length; len++) {
			const slice = nonEmptyGroups.slice(start, start + len)
			const tokens = slice.map((g) => g.fstToken)

			windows.push({
				key: tokens.join(" "),
				concatKey: tokens.join(""),
				startPos: start,
				endPos: start + len - 1,
				pieceIndices: slice.flatMap((g) => g.pieceIndices),
			})
		}
	}

	return windows
}

/**
 * Compute the segment index of every entry in `nonEmptyGroups`, by counting literal `,` characters in `inputText` that
 * fall strictly before each group's first piece's start offset (offsets, not piece-text inspection, so this is robust
 * to however the tokenizer happened to attach a comma piece to its neighboring word group — `groupPiecesIntoWords`
 * absorbs trailing punctuation into the preceding word's `pieceIndices`, so a comma's own piece span can land inside
 * either group depending on tokenization; counting commas strictly BEFORE a group's own start offset sidesteps that
 * ambiguity entirely). Shared by {@link buildSegmentWindows} (to know where segment boundaries fall) and
 * {@link isMarkerSuppressed} (to know whether a candidate's successor word is in the SAME segment or has already crossed
 * into the next one — see the module docstring's "Marker suppression" section).
 *
 * Without `inputText` (or an input with no commas at all), every group falls in segment 0.
 */
export function computeGroupSegments(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): number[] {
	const boundaryOffsets: number[] = []

	if (inputText) {
		for (let i = 0; i < inputText.length; i++) {
			// A NEWLINE counts alongside the comma (campaign R6). Multi-line is how postal addresses are actually
			// written — La Poste's line 5 puts the lieu-dit on its own line — and a line break is a stronger boundary
			// than a comma, never a weaker one. Before this, a newline-delimited address collapsed to a single segment,
			// the segment path went structurally inert, and the whole retrieval prior silently fell through to the
			// anchored path. It is why the FR golden board read 0/80 even after the leading-postcode fix landed: every
			// row on it is newline-delimited, the shape the formatter itself emits.
			if (inputText[i] === "," || inputText[i] === "\n") {
				boundaryOffsets.push(i)
			}
		}
	}

	// boundaryOffsets is built in ascending order, so `boundaryIdx` only ever advances — one linear pass across both.
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
 * Most trailing word-groups a segment-parent postcode strip will ever remove (#1308). A GB postcode is two space-split
 * word-groups at most (outward + inward, "SK11 9PD"); NZ is one (four digits). Two covers both — and, anchored
 * full-match against the country shape, a longer accidental run can't match a real postcode pattern anyway.
 */
export const MAX_TRAILING_POSTCODE_WORDS = 2

/**
 * Per-country postcode shape used ONLY by the segment path's trailing-postcode strip (#1308), keyed by the pair index
 * header's lowercase ISO country. Each entry is the SAME anchored shape codex owns as that system's source of truth
 * (`@mailwoman/codex/<system>`), so the strip and the postcode-repair / postcode-anchor passes never drift on what a GB
 * / NZ postcode is. Country-aware BY DESIGN: a header country with no entry here → no strip → byte-stable (see
 * {@link segmentParentPostcodeShape}). Grow this map only with a real codex shape for the added country.
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
 * Countries whose postal convention writes the postcode BEFORE the locality on the same line ("12210 Montpeyroux"),
 * rather than after it ("Macclesfield SK11 9PD").
 *
 * This distinction is why the FR instance (campaign R6) read 0/80 on a board whose pairs were 46% present in the index:
 * the segment probe stripped only a TRAILING postcode, so a French parent segment folded to "12210 montpeyroux" and
 * missed every bare-commune key. The mechanism, the index and the pairs were all correct — the probe carried an
 * Anglo-format assumption. Directly measured: "…, Pinsonnac, 12210 Montpeyroux" applied=false, while the same row with
 * the postcode removed applied=true and emitted dependent_locality=Pinsonnac.
 *
 * Membership is per-country and deliberately narrow: an entry is earned by a codex postcode shape plus a confound
 * board, not by the country merely writing the postcode first. FR/DE/ES/IT have all cleared that bar. A country absent
 * from this set is not an oversight to be corrected in passing — en-IN, for one, is absent BECAUSE the PIN goes last,
 * so the trailing-postcode strip already folds its parent segment correctly.
 */
export const LEADING_POSTCODE_COUNTRIES: ReadonlySet<string> = new Set(["fr", "de", "es", "it"])

/**
 * The trailing-postcode shape for the index's header country, or `undefined` (no country / no known shape → no strip).
 */
export function segmentParentPostcodeShape(country: string | undefined): RegExp | undefined {
	return country ? SEGMENT_PARENT_POSTCODE_SHAPES.get(country.toLowerCase()) : undefined
}

/**
 * Drop a TRAILING postcode-shaped run from a segment's fold tokens before it becomes a parent-candidate key (#1308).
 * The bug this closes: an idiomatic NZ / free-text GB address writes the postcode in the SAME comma-field as the post
 * town ("Porirua 5026", "Macclesfield SK11 9PD"), so the whole segment folds to "porirua 5026" / "macclesfield sk11
 * 9pd" and misses the index's bare "porirua" / "macclesfield" parent — the (child, parent) pair never fires. Stripping
 * the trailing postcode lets the town alone key the parent probe.
 *
 * Guards (all three from the issue): (1) only a TRAILING run — the longest suffix of
 * ≤{@link MAX_TRAILING_POSTCODE_WORDS} tokens whose bare concatenation full-matches `shape` (longest-first so a
 * two-token GB postcode strips whole); (2) NEVER the entire segment — `tokens.length < 2` returns unchanged, so a field
 * that IS just a postcode (the comma-separated "…, 5026" form) is left exactly as today and remains inert as before;
 * (3) country-aware — a `shape` of `undefined` (no header country, or no codex shape for it) returns the tokens
 * untouched, so the segment key is byte-identical to pre-#1308 behavior. No trailing postcode → the loop finds no match
 * and returns the input array.
 */
export function trailingSegmentPostcodeTake(tokens: readonly string[], shape: RegExp | undefined): number {
	if (shape === undefined || tokens.length < 2) return 0

	const maxTake = Math.min(tokens.length - 1, MAX_TRAILING_POSTCODE_WORDS)

	for (let take = maxTake; take >= 1; take--) {
		if (shape.test(tokens.slice(tokens.length - take).join(""))) return take
	}

	return 0
}

/**
 * Strip a LEADING postcode-shaped run from a segment's parent-candidate key — the mirror of
 * {@link stripTrailingSegmentPostcode} for countries that write "POSTCODE Commune" (see
 * {@link LEADING_POSTCODE_COUNTRIES}).
 *
 * Anchored full-match against the country shape exactly like the trailing form, so this can only ever remove a run that
 * IS a postcode for that country — never an ordinary leading word. Only the probe KEY changes; the segment itself and
 * every emitted span are untouched.
 */
export function leadingSegmentPostcodeTake(tokens: readonly string[], shape: RegExp | undefined): number {
	if (shape === undefined || tokens.length < 2) return 0

	const maxTake = Math.min(tokens.length - 1, MAX_TRAILING_POSTCODE_WORDS)

	for (let take = maxTake; take >= 1; take--) {
		if (shape.test(tokens.slice(0, take).join(""))) return take
	}

	return 0
}

/**
 * Build one candidate per comma-delimited SEGMENT of the input (segment mode) — see the module docstring's "Segment
 * mode" section for the venue-confound rationale. Groups sharing a segment index are always contiguous in
 * `nonEmptyGroups` (both lists are built in text order), so a single forward pass over the precomputed `groupSegments`
 * (see {@link computeGroupSegments}) suffices.
 *
 * `parentPostcodeShape` (the index's country trailing-postcode shape, #1308) strips a trailing postcode from the
 * segment's KEY forms only (see {@link trailingSegmentPostcodeTake}) — `startPos`/`endPos`/`pieceIndices` still span the
 * WHOLE segment, so disjointness, marker suppression, the identity-repeat check, and the CHILD bias write are all
 * byte-identical to pre-#1308 behavior; ONLY the probe key of a parent-candidate segment carrying a same-field postcode
 * changes.
 *
 * The one consumer that needs the narrower span is the whole-edge PARENT write (#46), which is why the stripped range
 * is also recorded as {@link CandidateWindow.keyPieceIndices} rather than thrown away.
 */
export function buildSegmentWindows(
	nonEmptyGroups: readonly WordGroup[],
	groupSegments: readonly number[],
	parentPostcodeShape: RegExp | undefined,
	leadingPostcodeShape: RegExp | undefined
): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	if (!nonEmptyGroups.length) return windows

	let segStart = 0

	for (let i = 1; i <= nonEmptyGroups.length; i++) {
		if (i === nonEmptyGroups.length || groupSegments[i] !== groupSegments[segStart]) {
			const slice = nonEmptyGroups.slice(segStart, i)

			// Both ends, because the postcode's position relative to the locality is a per-country convention:
			// "Macclesfield SK11 9PD" (GB/NZ) vs "12210 Montpeyroux" (FR). Each strip is an anchored full-match
			// against the country's own shape, so a country that only ever writes one form is unaffected by the
			// other pass — it simply never matches.
			const tokens = slice.map((g) => g.fstToken)
			const trailTake = trailingSegmentPostcodeTake(tokens, parentPostcodeShape)
			const leadTake = leadingSegmentPostcodeTake(tokens.slice(0, tokens.length - trailTake), leadingPostcodeShape)
			const keySlice = slice.slice(leadTake, slice.length - trailTake)
			const keyTokens = tokens.slice(leadTake, tokens.length - trailTake)

			windows.push({
				key: keyTokens.join(" "),
				concatKey: keyTokens.join(""),
				startPos: segStart,
				endPos: i - 1,
				pieceIndices: slice.flatMap((g) => g.pieceIndices),
				...(keySlice.length === slice.length ? {} : { keyPieceIndices: keySlice.flatMap((g) => g.pieceIndices) }),
			})

			segStart = i
		}
	}

	return windows
}

/**
 * Two windows are disjoint iff their word-group position ranges don't overlap (also excludes a window from itself).
 */
export function disjoint(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.endPos < b.startPos || b.endPos < a.startPos
}

/**
 * Do two candidates fold to an identical key under ANY of their fold forms? The identity test behind the repeated-name
 * convention (module docstring, "Identity pairs"). Plain repetition ("Mangawhai" / "Mangawhai") matches on `key ===
 * key`; the cross-form comparisons additionally catch a repeat written in two spellings of the same name
 * ("Stockton-on-Tees" folds to the single concat token "stocktonontees", which equals the concat form of "Stockton on
 * Tees") — the same dual-key bridging logic as {@link probeWindowPair}, applied to the identity question. Two genuinely
 * different places can only collide here if their FOLDS collide, i.e. they carry the same name text — which is exactly
 * the population the convention rule is scoped to.
 */
export function sharesFoldForm(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.key === b.key || a.key === b.concatKey || a.concatKey === b.key || a.concatKey === b.concatKey
}
