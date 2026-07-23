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
 *   bare-locality bar).
 *
 *   **Disable semantics (final-review fix — the previous wording here was self-contradictory).** This
 *   module has no notion of "on"/"off" by itself — `buildPlacetypePairPriors(opts, …)` just returns a
 *   zero matrix whenever `opts?.index` is absent, and the CALLER (`neural/classifier.ts`'s `#decode`)
 *   decides what `opts` resolves to. Three distinct cases, don't conflate them:
 *
 *   - **No config default, no per-call override** (e.g. `loadFromWeights({ locale: "en-us" })`, which
 *     ships no `pair-index-*.bin` sibling to auto-wire) — genuinely byte-identical to every parse before
 *     this arc: `opts` is `undefined` all the way down.
 *   - **A config default IS auto-wired** (`loadFromWeights` for an en-gb-shaped cache, Task 5) and the
 *     caller passes nothing per-call — the prior is ON, not off; omitting the per-call field does NOT
 *     recover byte-identical behavior in this case (see `ParseOpts.placetypePair`'s own doc comment for
 *     the exact resolution order).
 *   - **A config default is auto-wired and the caller wants it off for THIS call** — pass an explicit
 *     `placetypePair: false` per-call (typed disable, same shape as `spanProposer`). There is no
 *     config-level "null-index override" mechanism; the typed `false` on `ParseOpts` is the real
 *     mechanism.
 *
 *   **Probe mode — the 2026-07-22 venue-confound falsifier verdict, extended by the 2026-07-24 anchored
 *   adjacent-pair design** (`docs/superpowers/plans/2026-07-24-pair-prior-comma-scope-BRAINSTORM_RESPONSE.md`).
 *   `opts.probeMode` selects HOW a candidate is built, and it matters a great deal:
 *
 *   - `"auto"` (**DEFAULT**, v1.1) — the production probe CHAIN: the segment path first (engages iff the
 *     input splits into ≥2 comma-delimited segments, and then runs byte-identically to explicit
 *     `"segment"` mode — a construction property, the chain shares the segment path's code verbatim);
 *     when it cannot engage (a comma-free input is one giant segment — the population segment mode is
 *     deterministically inert on), the anchored-adjacent path takes over. Any anchored bias is strictly
 *     additive against what was previously a guaranteed zero matrix, so byte-stability outside the
 *     comma-free target population is trivial.
 *   - `"segment"` (the v1 default, still available as an explicit override) — a candidate is a WHOLE
 *     comma-delimited segment of the input, folded as one unit. See "Segment mode" below for the full
 *     contract. Comma-free input = one segment = zero matrix, the documented v1 trade-off.
 *   - `"anchored"` — the anchored adjacent-pair path alone (harness use; the chain reaches it only on
 *     comma-free input). See "Anchored mode" below.
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
 *   **Anchored mode (v1.1)** — the comma-free complement to segment mode, reached by the `"auto"` chain
 *   exactly where segment mode is structurally inert. The delta vs window mode is candidate SELECTION
 *   only (the probing/dual-key/bias machinery is shared verbatim): instead of probing every window
 *   against every other window anywhere in the string (the any-to-any geometry behind window mode's
 *   79% venue-confound FP at δ=10 — see the brainstorm doc's FP anatomy), candidates are pinned to the
 *   register-style GB suffix geometry: the PARENT (post-town position) is a 1..{@link WINDOW_MAX_WORDS}-word
 *   window immediately LEFT of a postcode-shaped span (shape per `postcode-repair.ts`'s
 *   {@link collectMatches} — the same family the repair pass and postcode-anchor path run; the anchor
 *   sits left of the WHOLE span, GB outward+inward included), or the string-FINAL window when no
 *   postcode shape is present. The CHILD is a 1..{@link ANCHORED_CHILD_MAX_WORDS}-word window
 *   immediately left of the parent (`child.endPos + 1 === parent.startPos`). Candidates are tried
 *   longest-match-first on both sides, which implements LEFT-MAXIMALITY for free: if extending the
 *   child one word left also pairs with the same parent, the longer child was already probed (and won)
 *   before the shorter one — a partial-child probe ("cadbury" under "north cadbury") can never fire.
 *   The FIRST hit biases the CHILD span only (the parent keeps the model's own — typically strong
 *   `locality` — read, matching how the other modes only ever bias the X role) and probing stops.
 *   Marker suppression applies to the child exactly as window mode applies it. A venue-embedded
 *   confound at the string start ("Queens Park Cafe …") is rejected by construction — its text is
 *   never immediately left of the post-town anchor.
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
 *   **Segment-boundary awareness (final-review fix).** In segment mode, the successor check only suppresses when the
 *   successor word is in the SAME comma-delimited segment as the candidate — a successor that has already crossed into
 *   the NEXT segment can never be read as a street/venue-head suffix of THIS candidate, because a comma sits between
 *   them. Reviewer repro: `"Fishburn, 5 Fishburn Road"` — "Fishburn" (segment 0) must NOT be suppressed by "5"
 *   (segment 1's first word, a house-number shape), because the comma means "5" is never a suffix of "Fishburn" in the
 *   source text. Since a segment-mode candidate already spans its ENTIRE segment (see "Segment mode" below), this
 *   check is structurally near-inert for segment mode's own candidates — the real protection against a "Church
 *   Road"-shaped false read is the whole-segment fusion itself ("Church Road" is one candidate, key "church road",
 *   never probed as bare "church"); the successor check here exists for defense-in-depth and to keep window mode's
 *   (comma-oblivious, unchanged) behavior sharing one code path. See `isMarkerSuppressed`'s doc comment for the exact
 *   mechanism.
 *
 *   **Bias write.** `+delta` on `B-<tag>` (window's first piece) / `I-<tag>` (the rest), same
 *   per-piece pattern as `fst-prior.ts`'s `applyBias` — `Math.max` against any bias already written by
 *   an earlier window, never additive-stacked. `delta` resolves as `index.delta ?? opts.biasScale ??`
 *   {@link DEFAULT_DELTA} — the real artifact's header carries the calibrated per-country `delta` (5.0 for GB as of the 2026-07-22 calibration; see task-7 sweep), so `biasScale` exists
 *   only as an override for a hand-built `PairIndexLike` test double that omits it.
 *
 *   Missing index (`opts` undefined, or `opts.index` absent) → zero matrix, composes harmlessly with
 *   `addEmissionMatrix`. Same for a present-but-empty/never-matching index (no country data loaded for
 *   this locale) — the probe loop simply never finds a tag.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import { groupPiecesIntoWords, type WordGroup } from "./fst-prior.ts"
import type { PairIndexLike } from "./pair-index-resolver.ts"
import { collectMatches } from "./postcode-repair.ts"
import type { TokenLike } from "./query-shape-prior.ts"

/**
 * P99 of the GB PPD `CITY` word-length distribution (Task 3, measured 2026-07-22; see the module docstring's table). A
 * dependent_locality-shaped candidate almost never spans more than 3 words in the source register that motivated this
 * prior; the observed max was 5 (287 of 9,031,691 rows).
 */
const WINDOW_MAX_WORDS = 3

/**
 * Anchored mode's child-window word cap. Wider than {@link WINDOW_MAX_WORDS} on purpose: the anchored geometry already
 * rejects the venue-confound class by construction (a venue phrase is never immediately left of the post-town anchor),
 * so the over-matching risk that froze the sliding-window cap at the p99 doesn't apply, and the observed register max
 * is 5 words with a real 4-word class ("Knott End on Sea" — experiment 0, task-8 report). Segment/window modes keep
 * their own caps unchanged.
 */
const ANCHORED_CHILD_MAX_WORDS = 4

/**
 * Bias magnitude used when neither the index nor the caller supplies one. Real usage always has `index.delta` (the
 * calibrated per-country delta from the artifact header, 5.0 for GB as of the 2026-07-22 calibration; see task-7
 * sweep), so this is a defensive fallback, not a tuned value.
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
 * 2026-07-22 venue-confound falsifier verdict and the 2026-07-24 anchored adjacent-pair design.
 *
 * - `"auto"` (**default**) — the production probe CHAIN: segment path when the input has ≥2 comma-delimited segments
 *   (byte-identical to explicit `"segment"` there, by construction), else the anchored-adjacent path.
 * - `"segment"` — a candidate is a WHOLE comma-delimited segment, folded as one unit. Requires `inputText` to find
 *   segment boundaries (see {@link PlacetypePairPriorOpts.inputText}); without it, the entire input is treated as one
 *   segment (matches the documented comma-free-input degradation, not a distinct failure mode).
 * - `"anchored"` — the anchored adjacent-pair path alone (see the module docstring's "Anchored mode" section). Explicit
 *   value for harness use; the chain reaches it only on comma-free input.
 * - `"window"` — the original sliding 1..{@link WINDOW_MAX_WORDS}-word behavior. Opt-in only; re-enabling as a default
 *   requires a venue-aware suppression mechanism AND a re-measured venue-confound FP=0 (see the module docstring).
 */
export type PlacetypePairProbeMode = "auto" | "segment" | "anchored" | "window"

/**
 * Out-record for trace support, mutated in place by {@link buildPlacetypePairPriors} when the caller supplies it via
 * {@link PlacetypePairPriorOpts.probeTrace}. `firedPath` is set only when at least one bias was actually written —
 * EFFECT, not configuration, matching the classifier's applied-flag pattern — and names the candidate-construction path
 * that produced it (under `"auto"`, which leg of the chain engaged).
 */
export interface PlacetypePairProbeTrace {
	firedPath?: "segment" | "anchored" | "window"
}

export interface PlacetypePairPriorOpts {
	/** The PIX1 pair index to probe. */
	index: PairIndexLike
	/**
	 * Fallback bias magnitude when `index.delta` is absent (a hand-built test double). Default 1.0 — see
	 * {@link DEFAULT_DELTA}.
	 */
	biasScale?: number
	/**
	 * Candidate-building strategy. Default `"auto"` (the segment→anchored probe chain) — see
	 * {@link PlacetypePairProbeMode} and the module docstring's "Probe mode" section for the 52.1% venue-confound FP
	 * measurement (2026-07-22, `.superpowers/sdd/task-6-report.md`) that set the v1 segment path, and the 2026-07-24
	 * anchored adjacent-pair design that added the comma-free leg.
	 */
	probeMode?: PlacetypePairProbeMode
	/**
	 * Raw input text — required for the segment path to locate comma boundaries via the tokenizer pieces' own character
	 * offsets (see {@link buildSegmentWindows}), and for the anchored path to locate a postcode-shaped span (see
	 * {@link resolveAnchorParentEnd}). Mirrors `query-shape-prior.ts`'s `BuildPriorsOpts.inputText`: the caller already
	 * has this string in hand (the same text passed to `tokenizer.encode`) and passes it straight through. Unused in
	 * `"window"` mode. Omitting it is not an error — the segment path degrades to treating the whole input as one segment
	 * (same as a genuinely comma-free query), the anchored path to the string-final parent anchor.
	 */
	inputText?: string
	/**
	 * Optional out-record: which probe path actually produced a bias (see {@link PlacetypePairProbeTrace}). Supplied by
	 * the classifier's trace path; mutated in place, never read by this module.
	 */
	probeTrace?: PlacetypePairProbeTrace
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
function computeGroupSegments(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): number[] {
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

	return nonEmptyGroups.map((group) => {
		const groupStart = pieces[group.pieceIndices[0]!]!.start

		while (commaIdx < commaOffsets.length && commaOffsets[commaIdx]! < groupStart) {
			commaIdx++
		}

		return commaIdx
	})
}

/**
 * Build one candidate per comma-delimited SEGMENT of the input (segment mode) — see the module docstring's "Segment
 * mode" section for the venue-confound rationale. Groups sharing a segment index are always contiguous in
 * `nonEmptyGroups` (both lists are built in text order), so a single forward pass over the precomputed `groupSegments`
 * (see {@link computeGroupSegments}) suffices.
 */
function buildSegmentWindows(
	nonEmptyGroups: readonly WordGroup[],
	groupSegments: readonly number[]
): CandidateWindow[] {
	const windows: CandidateWindow[] = []

	if (nonEmptyGroups.length === 0) return windows

	let segStart = 0

	for (let i = 1; i <= nonEmptyGroups.length; i++) {
		if (i === nonEmptyGroups.length || groupSegments[i] !== groupSegments[segStart]) {
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

/** Build the candidate for an explicit inclusive `[startPos, endPos]` word-group range (the anchored-mode selector). */
function makeCandidateWindow(nonEmptyGroups: readonly WordGroup[], startPos: number, endPos: number): CandidateWindow {
	const slice = nonEmptyGroups.slice(startPos, endPos + 1)
	const tokens = slice.map((g) => g.fstToken)

	return {
		key: tokens.join(" "),
		concatKey: tokens.join(""),
		startPos,
		endPos,
		pieceIndices: slice.flatMap((g) => g.pieceIndices),
	}
}

/**
 * Locate the anchored-mode parent anchor: the filtered word-group position the parent window must END at. With a
 * postcode-shaped span in the input (shape per {@link collectMatches} — the same per-country regex family the repair
 * pass and the postcode-anchor path run), that's the position immediately LEFT of the span's first word-group — left of
 * the WHOLE span, so a two-token GB postcode (outward + inward) never leaks into a parent candidate. Without a postcode
 * shape (or without `inputText` to search), the parent is string-final: the last word-group position.
 *
 * With several postcode-shaped spans, the LAST one (by start offset) anchors — string-final postcodes are the register
 * convention this mode targets. Can return `-1` (postcode shape at the very start of the string): the caller treats any
 * position `< 1` as "no room for a child left of the parent" and stays inert.
 */
function resolveAnchorParentEnd(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): number {
	const lastPos = nonEmptyGroups.length - 1

	if (!inputText) return lastPos

	const matches = collectMatches(inputText)

	if (matches.length === 0) return lastPos

	let anchor = matches[0]!

	for (const m of matches) {
		if (m.start > anchor.start) {
			anchor = m
		}
	}

	for (let i = 0; i < nonEmptyGroups.length; i++) {
		const group = nonEmptyGroups[i]!
		const start = pieces[group.pieceIndices[0]!]!.start
		const end = pieces[group.pieceIndices[group.pieceIndices.length - 1]!]!.end

		if (start < anchor.end && anchor.start < end) return i - 1
	}

	// The postcode-shaped span intersects no word-group (it fell inside text the tokenizer's word grouping dropped) —
	// degrade to the string-final anchor rather than going inert on a technicality.
	return lastPos
}

/**
 * The anchored adjacent-pair probe (see the module docstring's "Anchored mode" section): parent windows of
 * 1..{@link WINDOW_MAX_WORDS} words ending at `parentEnd`, child windows of 1..{@link ANCHORED_CHILD_MAX_WORDS} words
 * immediately left of the parent (`child.endPos + 1 === parent.startPos`), both tried longest-first — which is what
 * implements the left-maximality rule: for a given parent, the longest child pairing with it is found (and returned)
 * before any of its right-suffixes can be probed. Returns the FIRST hit; the caller biases the child span only.
 *
 * Marker suppression: an adjacent child's successor word is always the parent's own first word, identical for every
 * child length under that parent — so one suppressed child suppresses the whole child loop for that parent (`break`,
 * equivalent to window mode's per-candidate skip).
 */
function probeAnchoredAdjacentPair(
	index: PairIndexLike,
	nonEmptyGroups: readonly WordGroup[],
	parentEnd: number
): { child: CandidateWindow; tag: ComponentTag } | undefined {
	// parentStart must leave at least one word-group to its left for a child, so parentLen caps at parentEnd.
	const maxParentLen = Math.min(WINDOW_MAX_WORDS, parentEnd)

	for (let parentLen = maxParentLen; parentLen >= 1; parentLen--) {
		const parentStart = parentEnd - parentLen + 1
		const parent = makeCandidateWindow(nonEmptyGroups, parentStart, parentEnd)
		const childEnd = parentStart - 1
		const maxChildLen = Math.min(ANCHORED_CHILD_MAX_WORDS, childEnd + 1)

		for (let childLen = maxChildLen; childLen >= 1; childLen--) {
			const child = makeCandidateWindow(nonEmptyGroups, childEnd - childLen + 1, childEnd)

			if (isMarkerSuppressed(nonEmptyGroups, child)) break

			const tag = probeWindowPair(index, child, parent)

			if (tag) return { child, tag }
		}
	}

	return undefined
}

/**
 * Is `x` immediately followed (in the non-punctuation word sequence) by a structural marker?
 *
 * `groupSegments`, when supplied (segment mode only — see the call site), gates this on the successor sharing `x`'s OWN
 * segment. Without that gate, a candidate at the tail of one comma-delimited segment reads the FIRST word of the NEXT
 * segment as its "successor" — a false cross-segment reading, not a real street/venue-head suffix of this candidate.
 * Final-review fix (reviewer repro): `"Fishburn, 5 Fishburn Road"` — "Fishburn" (segment 0) was wrongly suppressed
 * because "5" (segment 1's first word, a house-number shape) sat next in `nonEmptyGroups`, even though the comma
 * between them means "5" can never be read as a suffix of "Fishburn". In WINDOW mode (`groupSegments` omitted),
 * suppression is unchanged — comma placement was never consulted there, by design (see `buildWindows`).
 */
function isMarkerSuppressed(
	nonEmptyGroups: readonly WordGroup[],
	x: CandidateWindow,
	groupSegments?: readonly number[]
): boolean {
	const successor = nonEmptyGroups[x.endPos + 1]

	if (!successor) return false

	if (groupSegments && groupSegments[x.endPos] !== groupSegments[x.endPos + 1]) return false

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

	const probeMode: PlacetypePairProbeMode = opts.probeMode ?? "auto"
	// `groupSegments` is only meaningful (and only computed) on the segment path — window mode's marker suppression
	// stays comma-blind by design (see `isMarkerSuppressed`'s doc comment), and the anchored path only ever handles
	// comma-free input, where every group shares segment 0 anyway.
	const needsSegments = probeMode === "segment" || probeMode === "auto"
	const groupSegments = needsSegments ? computeGroupSegments(nonEmptyGroups, pieces, opts.inputText) : undefined
	const segmentWindows = groupSegments ? buildSegmentWindows(nonEmptyGroups, groupSegments) : undefined

	// The "auto" probe-chain dispatch (v1.1 — module docstring, "Probe mode"): with <2 comma segments the segment path
	// is structurally inert (one giant candidate cannot pair with itself), so the anchored-adjacent path takes over.
	// With ≥2 segments the chain falls through to the segment loop below UNCHANGED — comma'd inputs are byte-identical
	// to explicit `"segment"` mode by construction, not by measurement.
	if (probeMode === "anchored" || (probeMode === "auto" && segmentWindows!.length < 2)) {
		const parentEnd = resolveAnchorParentEnd(nonEmptyGroups, pieces, opts.inputText)

		// A parent anchored at position 0 leaves no word-group to its left to serve as a child — inert.
		if (parentEnd < 1) return matrix

		const hit = probeAnchoredAdjacentPair(index, nonEmptyGroups, parentEnd)

		if (hit) {
			applyWindowBias(matrix, labelToCol, hit.child, hit.tag, bias)

			if (opts.probeTrace) {
				opts.probeTrace.firedPath = "anchored"
			}
		}

		return matrix
	}

	const windows = probeMode === "window" ? buildWindows(nonEmptyGroups, WINDOW_MAX_WORDS) : segmentWindows!

	// Segment mode collapses to one giant candidate on comma-free input (or a missing inputText) — no
	// second, disjoint candidate to pair against. Bail before the O(n²) loop below; this is the
	// documented comma-free-input degradation, not a bug.
	if (windows.length < 2) return matrix

	let anyApplied = false

	for (const x of windows) {
		if (isMarkerSuppressed(nonEmptyGroups, x, groupSegments)) continue

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
		anyApplied = true
	}

	if (anyApplied && opts.probeTrace) {
		opts.probeTrace.firedPath = probeMode === "window" ? "window" : "segment"
	}

	return matrix
}
