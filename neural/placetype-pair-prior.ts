/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Placetype-pair emission bias — the sixth emission prior (placetype-pair-prior arc, Task 4). The
 *   retrieval-augmented complement to the encoder's own judgment: probes contiguous word windows of
 *   the input against a PIX1 pair index (`pair-index-resolver.ts`) of (child, parent) place-name
 *   pairs harvested from a real address register (Task 3's GB shard: PPD `CITY`/`DISTRICT`), and
 *   nudges the matching BIO label when a window resolves.
 *
 *   Same additive-matrix contract as every other prior in this file (`fst-prior.ts`,
 *   `street-morphology-prior.ts`, `query-shape-prior.ts`'s `addEmissionMatrix`) — a `[seqLen][numLabels]`
 *   matrix the caller folds into the decoder's emissions before Viterbi. The encoder + the other
 *   priors still get the final vote; this one only proposes.
 *
 *   Evidence: rung-3 gate (2026-07-22) measured 100% recall / 0.0% false-positive rate at δ=6.0 on the
 *   probe set that motivated this prior. **Superseded by Task 7's δ calibration** (2026-07-22,
 *   `.superpowers/sdd/task-7-report.md`, a held-out register-row + venue-confound sweep) — the real
 *   `pair-index-gb.bin` artifact now ships δ=5.0 in its header (feed-8k's calibrated optimum and Task
 *   7's recommended ship checkpoint; feed-2k calibrates to 4.5 but fails the FR-fragment
 *   bare-locality bar). Default OFF: an omitted `opts` (no configured index) produces a zero matrix,
 *   byte-identical to every parse before this task.
 *
 *   **Probe mode — the 2026-07-22 venue-confound falsifier verdict.** `opts.probeMode` selects HOW a
 *   candidate is built, and it matters a great deal:
 *
 *   - `"segment"` (**DEFAULT**, v1) — a candidate is a WHOLE comma-delimited segment of the input, folded
 *     as one unit. See "Segment mode" below for the full contract.
 *   - `"window"` — the original sliding 1..{@link WINDOW_MAX_WORDS}-word behavior (see "Window mode"
 *     below), preserved unchanged for opt-in use.
 *
 *   The rung-3 gate above measured the prior's RECALL/FP on a curated probe set — real (child, parent)
 *   pairs in isolation, no surrounding venue text. Task 6 of this arc (`.superpowers/sdd/task-6-report.md`,
 *   2026-07-22) went looking for the failure mode a curated probe set can't see: a **6,500-row venue-confound
 *   board**, built from real UK Food Standards Agency establishment names that happen to embed a real GB
 *   place name inside a longer venue/business string ("Bitterne Charcoal Grill" embeds the place "Bitterne";
 *   "North Cadbury Village Stores Ltd" embeds "North Cadbury"). Run through the full pipeline with the prior
 *   ON in **window mode**, at the real artifact's δ=6.0, against the feed-2k dependent_locality-resurrected
 *   checkpoint: **52.123% false-positive rate** (3,388/6,500 rows emitted a `dependent_locality` span
 *   overlapping the venue's own text) — against a pre-registered FP=0 bar. Window mode's sub-segment
 *   sliding probe has no venue-boundary awareness: it finds "North Cadbury" as a 2-word window INSIDE
 *   "North Cadbury Village Stores Ltd" just as readily as it finds a bare "North Cadbury" standing alone,
 *   because a window is any contiguous 1..3-word run regardless of what larger phrase currently contains
 *   it. Marker suppression ({@link STRUCTURAL_MARKER_WORDS}) closes a handful of specific successor-word
 *   classes ("Church Road", "Manor House") but was never a general venue-boundary detector, and the
 *   venue-confound board's FP hits are dominated by venue name shapes the marker table was never built to
 *   catch ("… Stores Ltd", "… Academy", "… Charcoal Grill"). This is the arc's pre-registered fallback
 *   engaging: **segment mode is the v1 default**, and window mode moves behind this opt-in flag.
 *   Re-enabling window mode as a default requires BOTH (a) a venue-aware suppression mechanism (a
 *   venue/POI-name detector ahead of the prior, not just a fixed successor-word table) AND (b) a
 *   re-measured venue-confound FP of 0 on this same board (or its successor) with that mechanism engaged —
 *   see the task-6 report's "Concerns for whoever adjudicates the acceptance bars" §1 for the design options
 *   considered and not yet built.
 *
 *   **Segment mode.** A candidate is an ENTIRE comma-delimited segment of the input — not a sliding
 *   sub-window. Segments are reconstructed from the tokenizer pieces' own character offsets against the raw
 *   input text (`opts.inputText`, mirroring `query-shape-prior.ts`'s `BuildPriorsOpts.inputText` — the caller
 *   supplies the same raw text it already has in hand; see {@link buildSegmentWindows}): every literal `,`
 *   character in the input increments the segment counter, and each non-punctuation word group is assigned
 *   to the segment its first piece's start offset falls into. A segment's key is the WHOLE segment folded —
 *   both the space-joined form (each word's own fold, joined with `" "`) and the concat form (joined with no
 *   separator) — exactly the same dual-key contract as window mode's "dual-key probe" section below, just at
 *   segment granularity instead of per-window. This is what defeats the venue-confound class structurally:
 *   "North Cadbury Village Stores Ltd" is ONE segment (no internal comma), so its only candidate key is the
 *   5-word fold "north cadbury village stores ltd" — which never equals the census's 2-word "north cadbury"
 *   entry. A real place name only fires when it occupies a segment BY ITSELF (i.e. the input actually
 *   comma-delimits it as its own field) — which is exactly the shape a real structured address has
 *   ("5 Fishburn Road, Fishburn, Stockton-on-Tees") and a venue-embedding string does not.
 *
 *   Two known, honestly-reported trade-offs of the segment default (Task 6 measurements, all against the
 *   feed-2k checkpoint): (1) a residual FP class survives — when a non-venue FIELD (e.g. the venue-confound
 *   board's synthetic `street` field) happens to equal a bare census child verbatim as its OWN segment (e.g.
 *   `"Moelfre B & B, Moelfre, Abergele, …"` — the street segment is literally "Moelfre"), segment mode still
 *   fires, because the mechanism is purely textual/segmental, not semantic; this is not a bug in the segment
 *   restriction, it is the segment restriction doing exactly what it's specified to do. (2) recall on a
 *   comma-FREE input degrades toward inert, because a comma-free string is one giant segment with no
 *   internal split — see the task-6 report's Measurement 2(c) for the exact number. Window mode remains
 *   available, opt-in, for callers who have their own venue-boundary gate and have re-verified FP=0.
 *
 *   **Windowing (window mode only).** A candidate is any CONTIGUOUS run of 1..{@link WINDOW_MAX_WORDS}
 *   non-punctuation words (punctuation-only word groups, e.g. a bare comma, are skipped without breaking
 *   contiguity — same idiom as `fst-prior.ts`/`street-morphology-prior.ts`). `WINDOW_MAX_WORDS = 3` is the
 *   p99 of the GB PPD `CITY` word-length distribution measured building the Task-3 artifact (n=9,031,691
 *   non-empty-CITY rows):
 *
 *   | words | rows      | share  |
 *   |-------|-----------|--------|
 *   | 1     | 6,614,402 | 73.2%  |
 *   | 2     | 2,043,332 | 22.6%  |
 *   | 3     |   345,064 |  3.8%  |
 *   | 4     |    28,606 |  0.3%  |
 *   | 5     |       287 | <0.01% |
 *
 *   p50=1, p90=2, **p99=3**, max=5. Going to the observed max (5) buys negligible additional recall
 *   against real over-matching risk on short common words — 3 is the frozen scale; widening it is a
 *   future tunable, not a free lunch.
 *
 *   **The folded window key is a SPACE-JOIN of each word's own fold**, not a joint fold of the
 *   concatenated text: `normalizeFSTToken("St")` + `" "` + `normalizeFSTToken("Helens")` → `"st helens"`.
 *   This mirrors exactly how the Task-3 builder folds the source register's multi-word `CITY` values
 *   (`normalizeFSTToken` preserves interior Zs whitespace — see that function's docstring) — a window
 *   probe that instead concatenated the words with no separator (`"sthelens"`) would never hit a real
 *   index entry. See `placetype-pair-prior.test.ts` for the "St Helens" regression case.
 *
 *   **Dual-key probe (hyphen/space cross-form).** The space-join above is right for a source `CITY` value
 *   that was itself written with spaces ("St Helens"). It is WRONG for a source value that was written
 *   hyphenated ("Stockton-on-Tees") — `normalizeFSTToken` strips the hyphens as punctuation, so the Task-3
 *   builder folds that field to ONE concatenated token, `"stocktonontees"`, with no interior space at all.
 *   A query that instead WRITES the same place with spaces ("Stockton on Tees") groups into three
 *   `▁`-delimited words, and its space-joined window key (`"stockton on tees"`) never matches that
 *   concatenated index entry. So every window is probed under BOTH candidate keys — the space-join AND the
 *   bare concatenation (`slice.map(fstToken).join("")`) — for BOTH the X and Y role, since either side of a
 *   real pair can be the multi-word one. `probeWindows` tries the four `(x-form, y-form)` combinations in a
 *   fixed order — space/space, space/concat, concat/space, concat/concat — and returns on the first hit: a
 *   real index cannot disagree with itself on the SAME pair of real-world places, but if a contrived index
 *   ever did resolve two different tags across forms, this order means the space-joined attempt (tried
 *   first) wins. A single-word window's two forms are identical strings, so this costs nothing extra for
 *   the common case — the extra probes only fire for genuine multi-word windows.
 *
 *   **Two-sided, order-free matching.** For each candidate window X (in either textual position
 *   relative to any other window — "two-sided" means the search for a matching partner is NOT limited
 *   to windows that follow X, unlike the forward-only FST walk in `fst-prior.ts`), X gets a bias iff
 *   some OTHER, DISJOINT window Y (word-group ranges must not overlap) anywhere in the input satisfies
 *   `index.probe(x.key, y.key) === tag`. Looping every window through the X role (not just probing one
 *   direction from a fixed anchor) is what makes the pair discoverable regardless of which of the two
 *   real-world roles (child/parent) happens to come first in the query text — a real (child, parent)
 *   pair is found once per member, independently, when that member takes the X role in its own
 *   iteration. Distance/adjacency between X and Y is NOT weighted — a future tunable, frozen at "off"
 *   for this task per the same "note as a future tunable" discipline as `fst-prior.ts`'s length-scaling
 *   header.
 *
 *   **Marker suppression** (the DeepSeek venue-confound filter) — **active in both probe modes,
 *   unchanged by the segment-mode default**. A candidate immediately followed by a structural-marker word
 *   (or a house-number-shaped token) is a street/venue HEAD, not a standalone place reference, and is
 *   skipped outright — no probe, no bias — regardless of whether it would otherwise have matched.
 *   Rationale per marker, see {@link STRUCTURAL_MARKER_WORDS}: without this, a pair-index entry like
 *   `("church", "some-locality")` would fire on "Church" in "Church House" / "Church Road" / "Church
 *   Court" — none of which are the place "Church", all of which are street/venue names that happen to
 *   START with a word the register also knows as a place name somewhere else in the country. This is a
 *   narrower, purely lexical defense than the venue-confound falsifier above needed — it was never meant
 *   to be a general venue-boundary detector, which is exactly why the segment restriction exists
 *   alongside it rather than instead of it.
 *
 *   **Bias write.** `+delta` on `B-<tag>` (window's first piece) / `I-<tag>` (the rest), same
 *   per-piece pattern as `fst-prior.ts`'s `applyBias` — `Math.max` against any bias already written by
 *   an earlier window, never additive-stacked. `delta` resolves as `index.delta ?? opts.biasScale ??`
 *   {@link DEFAULT_DELTA} — the real artifact's header carries `delta` (6.0), so `biasScale` exists
 *   only as an override for a hand-built `PairIndexLike` test double that omits it.
 *
 *   Missing index (`opts` undefined, or `opts.index` absent) → zero matrix, composes harmlessly with
 *   `addEmissionMatrix`. Same for a present-but-empty/never-matching index (no country data loaded for
 *   this locale) — the probe loop simply never finds a tag.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import { groupPiecesIntoWords, type WordGroup } from "./fst-prior.ts"
import type { PairIndexLike } from "./pair-index-resolver.ts"
import type { TokenLike } from "./query-shape-prior.ts"

/**
 * P99 of the GB PPD `CITY` word-length distribution (Task 3, measured 2026-07-22; see the module docstring's table). A
 * dependent_locality-shaped candidate almost never spans more than 3 words in the source register that motivated this
 * prior; the observed max was 5 (287 of 9,031,691 rows).
 */
const WINDOW_MAX_WORDS = 3

/**
 * Bias magnitude used when neither the index nor the caller supplies one. Real usage always has `index.delta` (the
 * Task-3 artifact's header carries 6.0), so this is a defensive fallback, not a tuned value.
 */
const DEFAULT_DELTA = 1.0

/**
 * Structural-marker words: a candidate window immediately followed by one of these is the HEAD of a street/venue name,
 * not a standalone place reference. Each entry's rationale is the specific false-positive class it closes (DeepSeek
 * venue-confound review, rung-3):
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
const STRUCTURAL_MARKER_WORDS: ReadonlySet<string> = new Set(["house", "road", "street", "flat", "court"])

/**
 * A bare house-number shape ("5", "12a", "104b") — the successor CLASS the marker table's rationale calls out alongside
 * the fixed word list: a window followed by what looks like a house number reads as a numbered-street head ("Church
 * 5"-style patterns in some registers), not a place name. Same suppression rationale as the fixed words, expressed as a
 * shape test instead of a literal set (a house number is not enumerable).
 */
function looksLikeHouseNumber(token: string): boolean {
	return /^\d+[a-z]?$/.test(token)
}

/**
 * `probeMode` selects the candidate-building strategy — see the module docstring's "Probe mode" section for the
 * 2026-07-22 venue-confound falsifier verdict that motivates the default.
 *
 * - `"segment"` (**default**) — a candidate is a WHOLE comma-delimited segment, folded as one unit. Requires `inputText`
 *   to find segment boundaries (see {@link PlacetypePairPriorOpts.inputText}); without it, the entire input is treated
 *   as one segment (matches the documented comma-free-input degradation, not a distinct failure mode).
 * - `"window"` — the original sliding 1..{@link WINDOW_MAX_WORDS}-word behavior. Opt-in only; re-enabling as a default
 *   requires a venue-aware suppression mechanism AND a re-measured venue-confound FP=0 (see the module docstring).
 */
export type PlacetypePairProbeMode = "segment" | "window"

export interface PlacetypePairPriorOpts {
	/** The PIX1 pair index to probe. */
	index: PairIndexLike
	/**
	 * Fallback bias magnitude when `index.delta` is absent (a hand-built test double). Default 1.0 — see
	 * {@link DEFAULT_DELTA}.
	 */
	biasScale?: number
	/**
	 * Candidate-building strategy. Default `"segment"` — see {@link PlacetypePairProbeMode} and the module docstring's
	 * "Probe mode" section for the 52.1% venue-confound FP measurement (2026-07-22, `.superpowers/sdd/task-6-report.md`)
	 * that set this default.
	 */
	probeMode?: PlacetypePairProbeMode
	/**
	 * Raw input text — required for `probeMode: "segment"` to locate comma boundaries via the tokenizer pieces' own
	 * character offsets (see {@link buildSegmentWindows}). Mirrors `query-shape-prior.ts`'s `BuildPriorsOpts.inputText`:
	 * the caller already has this string in hand (the same text passed to `tokenizer.encode`) and passes it straight
	 * through. Unused in `"window"` mode. Omitting it in segment mode is not an error — it degrades to treating the whole
	 * input as one segment, same as a genuinely comma-free query.
	 */
	inputText?: string
}

/**
 * A candidate — either a 1..{@link WINDOW_MAX_WORDS}-word sliding window (window mode) or a whole comma-delimited
 * segment (segment mode).
 */
interface CandidateWindow {
	/** The space-joined fold — see the module docstring's "St Helens" → "st helens" note. */
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
}

/** Build every contiguous 1..maxWords window over the non-punctuation word groups (window mode). */
function buildWindows(nonEmptyGroups: readonly WordGroup[], maxWords: number): CandidateWindow[] {
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
 * Build one candidate per comma-delimited SEGMENT of the input (segment mode) — see the module docstring's "Segment
 * mode" section for the venue-confound rationale. Segment boundaries are reconstructed from the tokenizer pieces' own
 * character offsets against `inputText`: every literal `,` in `inputText` increments the running segment counter, and
 * each non-punctuation word group is assigned to the segment its FIRST piece's start offset falls into (offsets, not
 * piece-text inspection, so this is robust to however the tokenizer happened to attach a comma piece to its neighboring
 * word group — `groupPiecesIntoWords` absorbs trailing punctuation into the preceding word's `pieceIndices`, so a
 * comma's own piece span can land inside either group depending on tokenization; counting commas strictly BEFORE a
 * group's own start offset sidesteps that ambiguity entirely). Groups sharing a segment index are always contiguous in
 * `nonEmptyGroups` (both lists are built in text order), so a single forward pass suffices.
 *
 * Without `inputText` (or an input with no commas at all), every group falls in segment 0 — the whole input becomes ONE
 * candidate, matching the documented comma-free-input degradation rather than silently doing something else.
 */
function buildSegmentWindows(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	if (nonEmptyGroups.length === 0) return windows

	const commaOffsets: number[] = []

	if (inputText) {
		for (let i = 0; i < inputText.length; i++) {
			if (inputText[i] === ",") {
				commaOffsets.push(i)
			}
		}
	}

	// commaOffsets is built in ascending order, so `commaIdx` only ever advances — one linear pass across both lists.
	let commaIdx = 0
	const segmentOf = (group: WordGroup): number => {
		const groupStart = pieces[group.pieceIndices[0]!]!.start

		while (commaIdx < commaOffsets.length && commaOffsets[commaIdx]! < groupStart) {
			commaIdx++
		}

		return commaIdx
	}

	let segStart = 0
	let segIndex = segmentOf(nonEmptyGroups[0]!)

	for (let i = 1; i <= nonEmptyGroups.length; i++) {
		const nextSegIndex = i < nonEmptyGroups.length ? segmentOf(nonEmptyGroups[i]!) : -1

		if (i === nonEmptyGroups.length || nextSegIndex !== segIndex) {
			const slice = nonEmptyGroups.slice(segStart, i)
			const tokens = slice.map((g) => g.fstToken)

			windows.push({
				key: tokens.join(" "),
				concatKey: tokens.join(""),
				startPos: segStart,
				endPos: i - 1,
				pieceIndices: slice.flatMap((g) => g.pieceIndices),
			})
			segStart = i
			segIndex = nextSegIndex
		}
	}

	return windows
}

/** Two windows are disjoint iff their word-group position ranges don't overlap (also excludes a window from itself). */
function disjoint(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.endPos < b.startPos || b.endPos < a.startPos
}

/**
 * Probe `index` for the `(x, y)` pair under every combination of their space-joined/concatenated key forms — see the
 * module docstring's "dual-key probe" section. Tries space/space, space/concat, concat/space, concat/concat in that
 * order and returns the first hit; a window's two forms collapse to one string when it's a single word, so this is a
 * single probe (not four) for the common case.
 */
function probeWindowPair(index: PairIndexLike, x: CandidateWindow, y: CandidateWindow): ComponentTag | undefined {
	const xKeys = x.key === x.concatKey ? [x.key] : [x.key, x.concatKey]
	const yKeys = y.key === y.concatKey ? [y.key] : [y.key, y.concatKey]

	for (const xKey of xKeys) {
		for (const yKey of yKeys) {
			const tag = index.probe(xKey, yKey)

			if (tag) return tag
		}
	}

	return undefined
}

/** Is `x` immediately followed (in the non-punctuation word sequence) by a structural marker? */
function isMarkerSuppressed(nonEmptyGroups: readonly WordGroup[], x: CandidateWindow): boolean {
	const successor = nonEmptyGroups[x.endPos + 1]

	if (!successor) return false

	return STRUCTURAL_MARKER_WORDS.has(successor.fstToken) || looksLikeHouseNumber(successor.fstToken)
}

/** Write `bias` onto `B-<tag>`/`I-<tag>` for every piece in `window`, `Math.max`'d against whatever's already there. */
function applyWindowBias(
	matrix: number[][],
	labelToCol: ReadonlyMap<string, number>,
	window: CandidateWindow,
	tag: ComponentTag,
	bias: number
): void {
	const bCol = labelToCol.get(`B-${tag}`)
	const iCol = labelToCol.get(`I-${tag}`)

	if (bCol === undefined) return

	for (let k = 0; k < window.pieceIndices.length; k++) {
		const pi = window.pieceIndices[k]!
		const col = k === 0 ? bCol : (iCol ?? bCol)

		matrix[pi]![col] = Math.max(matrix[pi]![col]!, bias)
	}
}

/**
 * Build a `[seqLen][numLabels]` bias matrix from placetype-pair index matches. See the module docstring for the full
 * windowing/matching/suppression contract.
 */
export function buildPlacetypePairPriors(
	opts: PlacetypePairPriorOpts | undefined,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>
): number[][] {
	const T = pieces.length
	const L = labels.length
	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	if (!opts?.index) return matrix

	const { index } = opts
	const bias = index.delta ?? opts.biasScale ?? DEFAULT_DELTA

	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}

	const wordGroups = groupPiecesIntoWords(pieces)
	const nonEmptyGroups = wordGroups.filter((g) => g.fstToken !== "")

	if (nonEmptyGroups.length < 2) return matrix // need ≥2 disjoint candidates to form a pair

	const probeMode: PlacetypePairProbeMode = opts.probeMode ?? "segment"
	const windows =
		probeMode === "window"
			? buildWindows(nonEmptyGroups, WINDOW_MAX_WORDS)
			: buildSegmentWindows(nonEmptyGroups, pieces, opts.inputText)

	// Segment mode collapses to one giant candidate on comma-free input (or a missing inputText) — no
	// second, disjoint candidate to pair against. Bail before the O(n²) loop below; this is the
	// documented comma-free-input degradation, not a bug.
	if (windows.length < 2) return matrix

	for (const x of windows) {
		if (isMarkerSuppressed(nonEmptyGroups, x)) continue

		let matchedTag: ComponentTag | undefined

		for (const y of windows) {
			if (!disjoint(x, y)) continue

			const tag = probeWindowPair(index, x, y)

			if (tag) {
				matchedTag = tag
				break
			}
		}

		if (!matchedTag) continue

		applyWindowBias(matrix, labelToCol, x, matchedTag, bias)
	}

	return matrix
}
