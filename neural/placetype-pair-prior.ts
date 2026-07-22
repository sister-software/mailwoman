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
 *   probe set that motivated this prior — the real `pair-index-gb.bin` artifact (Task 3) ships that
 *   delta in its header. Default OFF: an omitted `opts` (no configured index) produces a zero matrix,
 *   byte-identical to every parse before this task.
 *
 *   **Windowing.** A candidate is any CONTIGUOUS run of 1..{@link WINDOW_MAX_WORDS} non-punctuation
 *   words (punctuation-only word groups, e.g. a bare comma, are skipped without breaking contiguity —
 *   same idiom as `fst-prior.ts`/`street-morphology-prior.ts`). `WINDOW_MAX_WORDS = 3` is the p99 of
 *   the GB PPD `CITY` word-length distribution measured building the Task-3 artifact (n=9,031,691
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
 *   **Marker suppression** (the DeepSeek venue-confound filter). A window immediately followed by a
 *   structural-marker word (or a house-number-shaped token) is a street/venue HEAD, not a standalone
 *   place reference, and is skipped outright — no probe, no bias — regardless of whether it would
 *   otherwise have matched. Rationale per marker, see {@link STRUCTURAL_MARKER_WORDS}: without this, a
 *   pair-index entry like `("church", "some-locality")` would fire on "Church" in "Church House" /
 *   "Church Road" / "Church Court" — none of which are the place "Church", all of which are
 *   street/venue names that happen to START with a word the register also knows as a place name
 *   somewhere else in the country.
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

export interface PlacetypePairPriorOpts {
	/** The PIX1 pair index to probe. */
	index: PairIndexLike
	/**
	 * Fallback bias magnitude when `index.delta` is absent (a hand-built test double). Default 1.0 — see
	 * {@link DEFAULT_DELTA}.
	 */
	biasScale?: number
}

/** A candidate word-window: 1..{@link WINDOW_MAX_WORDS} contiguous non-punctuation words. */
interface CandidateWindow {
	/** The space-joined fold — see the module docstring's "St Helens" → "st helens" note. */
	key: string
	/**
	 * Inclusive position range within the FILTERED (non-punctuation) word-group list — used for the disjointness check
	 * and to locate the immediately-following word for marker suppression.
	 */
	startPos: number
	endPos: number
	pieceIndices: number[]
}

/** Build every contiguous 1..maxWords window over the non-punctuation word groups. */
function buildWindows(nonEmptyGroups: readonly WordGroup[], maxWords: number): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	for (let start = 0; start < nonEmptyGroups.length; start++) {
		for (let len = 1; len <= maxWords && start + len <= nonEmptyGroups.length; len++) {
			const slice = nonEmptyGroups.slice(start, start + len)

			windows.push({
				key: slice.map((g) => g.fstToken).join(" "),
				startPos: start,
				endPos: start + len - 1,
				pieceIndices: slice.flatMap((g) => g.pieceIndices),
			})
		}
	}

	return windows
}

/** Two windows are disjoint iff their word-group position ranges don't overlap (also excludes a window from itself). */
function disjoint(a: CandidateWindow, b: CandidateWindow): boolean {
	return a.endPos < b.startPos || b.endPos < a.startPos
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

	if (nonEmptyGroups.length < 2) return matrix // need ≥2 disjoint windows to form a pair

	const windows = buildWindows(nonEmptyGroups, WINDOW_MAX_WORDS)

	for (const x of windows) {
		if (isMarkerSuppressed(nonEmptyGroups, x)) continue

		let matchedTag: ComponentTag | undefined

		for (const y of windows) {
			if (!disjoint(x, y)) continue

			const tag = index.probe(x.key, y.key)

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
