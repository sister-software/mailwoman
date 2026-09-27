/**
 * Placetype-pair emission prior.
 *
 * Probes child/parent place-name pairs from the loaded index and writes BIO bias into an emission matrix.
 * It supports auto/segment/anchored/window probe modes, marker suppression, optional
 * transition adjustments, optional parent-tag bias, and optional census trace observability.
 *
 * No index means no-op: a zero matrix and no transition adjustments.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { groupPiecesIntoWords, type WordGroup } from "#fst-prior"
import type { PairEdge, PairIndexLike } from "#pair/index/resolver"
import {
	ANCHORED_CHILD_MAX_WORDS,
	segmentParentPostcodeShape,
	buildSegmentWindows,
	buildWindows,
	type CandidateWindow,
	computeGroupSegments,
	DEFAULT_DELTA,
	disjoint,
	hasTitlePrepositionPredecessor,
	LEADING_POSTCODE_COUNTRIES,
	looksLikeHouseNumber,
	sharesFoldForm,
	STRUCTURAL_MARKER_WORDS,
	WINDOW_MAX_WORDS,
} from "#pair/prior-windows"
import type { PlacetypeCensusLike } from "#placetype/census"
import { collectMatches } from "#postcode/repair"
import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import type { TokenLike } from "#query-shape-prior"

/**
 * `probeMode` selects how candidates are built.
 *
 * - `"auto"` (default): segment path when possible, otherwise anchored.
 * - `"segment"`: whole comma-delimited segments.
 * - `"anchored"`: anchored adjacent child/parent windows.
 * - `"window"`: sliding windows up to {@link WINDOW_MAX_WORDS}.
 */
type PlacetypePairProbeMode = "auto" | "segment" | "anchored" | "window"

/**
 * Trace out-record, mutated in place by {@link buildPlacetypePairPriors}.
 */
export interface PlacetypeCensusObservation {
	/**
	 * Folded parent surface that hit the census.
	 */
	parent: string
	/**
	 * Child tags present for this parent.
	 */
	childTagsPresent: ComponentTag[]
	/**
	 * Per-tag lift relative to country base rate.
	 */
	lift: Partial<Record<ComponentTag, number>>
}

export interface PlacetypePairProbeTrace {
	firedPath?: "segment" | "anchored" | "window"
	/**
	 * Census hits recorded for probed parent surfaces.
	 */
	censusObservations?: PlacetypeCensusObservation[]
	/**
	 * Number of distinct parent surfaces probed against census.
	 */
	censusProbedParents?: number
	/**
	 * Child tags asserted by pair hits, in fire order.
	 */
	firedChildTags?: ComponentTag[]
}

export interface PlacetypePairPriorOpts {
	/**
	 * The PIX1 pair index to probe.
	 */
	index: PairIndexLike
	/**
	 * Fallback bias when `index.delta` is absent.
	 */
	biasScale?: number
	/**
	 * Candidate-building strategy.
	 * Default: `"auto"`.
	 */
	probeMode?: PlacetypePairProbeMode
	/**
	 * Raw input text used by segment and anchored paths.
	 */
	inputText?: string
	/**
	 * Optional trace out-record, mutated in place.
	 */
	probeTrace?: PlacetypePairProbeTrace
	/**
	 * Optional census for observability.
	 * Scoring reads the same values with it present or absent.
	 */
	census?: PlacetypeCensusLike
	/**
	 * Optional parent-window bias.
	 * When set, it overrides `index.parentDelta`.
	 */
	parentDelta?: number
}

/**
 * Position-scoped transition bonus: apply `+bonus` to transitions entering `toLabel` at `pieceIndex`.
 */
interface TransitionAdjustment {
	/**
	 * Piece position whose incoming transition is adjusted.
	 */
	pieceIndex: number
	/**
	 * Destination BIO label.
	 */
	toLabel: string
	/**
	 * Additive bonus.
	 */
	bonus: number
}

/**
 * Return type for {@link buildPlacetypePairPriors}.
 */
export interface PlacetypePairPriorResult {
	matrix: number[][]
	transitionAdjustments: TransitionAdjustment[]
}

/**
 * Census side-probe callback for parent candidates.
 */
type CensusParentRecorder = (parent: CandidateWindow) => void

/**
 * Build the census recorder, or `undefined` when census/trace is missing.
 *
 * Dedupes parent surfaces and records probes/hits in the trace object.
 */
function makeCensusParentRecorder(
	census: PlacetypeCensusLike | undefined,
	trace: PlacetypePairProbeTrace | undefined
): CensusParentRecorder | undefined {
	if (!census || !trace) return undefined

	const observations: PlacetypeCensusObservation[] = (trace.censusObservations ??= [])
	const seen = new Set<string>()

	trace.censusProbedParents ??= 0

	return (parent) => {
		const keys = parent.key === parent.concatKey ? [parent.key] : [parent.key, parent.concatKey]
		const dedupeKey = keys.join("\0")

		if (seen.has(dedupeKey)) return

		seen.add(dedupeKey)
		trace.censusProbedParents = (trace.censusProbedParents ?? 0) + 1

		for (const key of keys) {
			const node = census.probe(key)

			if (!node) continue

			// Keep artifact-provided ordering of counts.
			const childTagsPresent = (Object.entries(node.counts) as Array<[ComponentTag, number | undefined]>)
				.filter((entry): entry is [ComponentTag, number] => typeof entry[1] === "number" && entry[1] > 0)
				.map(([tag]) => tag)

			const lift: Partial<Record<ComponentTag, number>> = {}

			for (const tag of childTagsPresent) {
				lift[tag] = census.lift(key, tag)
			}

			observations.push({ parent: key, childTagsPresent, lift })

			return
		}
	}
}

/**
 * Probe `(x, y)` using both space and concat key forms.
 * Returns the first matching edge, if any.
 */
function probeWindowPair(
	index: PairIndexLike,
	x: CandidateWindow,
	y: CandidateWindow,
	recordCensusParent?: CensusParentRecorder
): PairEdge | undefined {
	recordCensusParent?.(y)

	const xKeys = x.key === x.concatKey ? [x.key] : [x.key, x.concatKey]
	const yKeys = y.key === y.concatKey ? [y.key] : [y.key, y.concatKey]

	for (const xKey of xKeys) {
		for (const yKey of yKeys) {
			const edge = index.probe(xKey, yKey)

			if (edge) return edge
		}
	}

	return undefined
}

/**
 * Build a candidate window from an inclusive word-group range.
 */
function makeCandidateWindow(nonEmptyGroups: readonly WordGroup[], startPos: number, endPos: number): CandidateWindow {
	const groups = nonEmptyGroups.slice(startPos, endPos + 1)
	const tokens = groups.map((g) => g.fstToken)

	return {
		key: tokens.join(" "),
		concatKey: tokens.join(""),
		startPos,
		endPos,
		pieceIndices: groups.flatMap((g) => g.pieceIndices),
	}
}

/**
 * Resolve anchored-mode parent end position.
 *
 * Uses the last postcode-shaped span when present.
 * An input carrying none uses the string-final position.
 */
function resolveAnchorParentEnd(
	nonEmptyGroups: readonly WordGroup[],
	pieces: ReadonlyArray<TokenLike>,
	inputText: string | undefined
): number {
	const lastPos = nonEmptyGroups.length - 1

	if (!inputText) return lastPos

	const matches = collectMatches(inputText)

	if (!matches.length) return lastPos

	let anchor = matches[0]!

	for (const m of matches) {
		if (m.start > anchor.start) {
			anchor = m
		}
	}

	for (let i = 0; i < nonEmptyGroups.length; i++) {
		const group = nonEmptyGroups[i]!
		const start = pieces[group.pieceIndices[0]!]!.start
		const end = pieces[group.pieceIndices.at(-1)!]!.end

		if (start < anchor.end && anchor.start < end) return i - 1
	}

	// If no group intersects the span, fall back to string-final anchor.
	return lastPos
}

/**
 * Anchored adjacent-pair probe.
 *
 * Tries parent and left-adjacent child windows longest-first and returns first hit.
 */
function probeAnchoredAdjacentPair(
	index: PairIndexLike,
	nonEmptyGroups: readonly WordGroup[],
	parentEnd: number,
	recordCensusParent?: CensusParentRecorder
): { child: CandidateWindow; parent: CandidateWindow; edge: PairEdge } | undefined {
	// Parent length must leave at least one word for a child.
	const maxParentLen = Math.min(WINDOW_MAX_WORDS, parentEnd)

	for (let parentLen = maxParentLen; parentLen >= 1; parentLen--) {
		const parentStart = parentEnd - parentLen + 1
		const parent = makeCandidateWindow(nonEmptyGroups, parentStart, parentEnd)
		const childEnd = parentStart - 1
		const maxChildLen = Math.min(ANCHORED_CHILD_MAX_WORDS, childEnd + 1)

		for (let childLen = maxChildLen; childLen >= 1; childLen--) {
			const child = makeCandidateWindow(nonEmptyGroups, childEnd - childLen + 1, childEnd)

			if (isMarkerSuppressed(nonEmptyGroups, child)) break

			const edge = probeWindowPair(index, child, parent, recordCensusParent)

			if (edge) return { child, parent, edge }
		}
	}

	return undefined
}

/**
 * True if `x` is followed by a structural marker or house-number-like token.
 * In segment mode, only checks within the same segment.
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

/**
 * Append a fired child tag to trace (no-op without trace).
 */
function recordFiredChildTag(trace: PlacetypePairProbeTrace | undefined, tag: ComponentTag): void {
	if (!trace) return

	trace.firedChildTags ??= []
	trace.firedChildTags.push(tag)
}

/**
 * Write BIO span bias with `Math.max` composition.
 * Returns false when `B-<tag>` is missing from labels.
 */
function writeSpanBias(
	matrix: number[][],
	labelToCol: ReadonlyMap<string, number>,
	pieceIndices: readonly number[],
	tag: ComponentTag,
	bias: number
): boolean {
	const bCol = labelToCol.get(`B-${tag}`)
	const iCol = labelToCol.get(`I-${tag}`)

	if (bCol === undefined) return false

	for (let k = 0; k < pieceIndices.length; k++) {
		const pi = pieceIndices[k]!
		const col = k === 0 ? bCol : (iCol ?? bCol)

		matrix[pi]![col] = Math.max(matrix[pi]![col]!, bias)
	}

	return true
}

/**
 * Apply parent-tag emission bias for a matched pair edge.
 *
 * Uses edge-provided `parentTag`; no transition adjustment is emitted.
 */
function applyParentTagBias(
	matrix: number[][],
	labelToCol: ReadonlyMap<string, number>,
	parent: CandidateWindow,
	parentTag: ComponentTag,
	parentDelta: number
): void {
	// Prefer key-only span when provided.
	writeSpanBias(matrix, labelToCol, parent.keyPieceIndices ?? parent.pieceIndices, parentTag, parentDelta)
}

/**
 * Apply emission bias to a child window.
 * Optionally adds transition adjustment at the window start.
 */
function applyWindowBias(
	nonEmptyGroups: readonly WordGroup[],
	matrix: number[][],
	labelToCol: ReadonlyMap<string, number>,
	window: CandidateWindow,
	tag: ComponentTag,
	bias: number,
	transitionBeta: number | undefined,
	adjustments: TransitionAdjustment[]
): void {
	if (!writeSpanBias(matrix, labelToCol, window.pieceIndices, tag, bias)) return

	if (transitionBeta === undefined || !window.pieceIndices.length) return

	if (hasTitlePrepositionPredecessor(nonEmptyGroups, window)) return

	const pieceIndex = window.pieceIndices[0]!
	const toLabel = `B-${tag}`
	const existing = adjustments.find((a) => a.pieceIndex === pieceIndex && a.toLabel === toLabel)

	if (existing) {
		existing.bonus = Math.max(existing.bonus, transitionBeta)
	} else {
		adjustments.push({ pieceIndex, toLabel, bonus: transitionBeta })
	}
}

/**
 * Build emission bias matrix and optional transition adjustments from pair-index hits.
 */
export function buildPlacetypePairPriors(
	opts: PlacetypePairPriorOpts | undefined,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>
): PlacetypePairPriorResult {
	const T = pieces.length
	const L = labels.length
	const matrix = emptyPriorMatrix(T, L)
	const transitionAdjustments: TransitionAdjustment[] = []

	if (!opts?.index) return { matrix, transitionAdjustments }

	const { index } = opts
	const bias = index.delta ?? opts.biasScale ?? DEFAULT_DELTA
	const transitionBeta = index.transitionBeta
	// Explicit option overrides header value.
	const parentDelta = opts.parentDelta ?? index.parentDelta

	// Census recorder is inert when census/trace is missing.
	const recordCensusParent = makeCensusParentRecorder(opts.census, opts.probeTrace)

	const labelToCol = labelColumnIndex(labels)

	const wordGroups = groupPiecesIntoWords(pieces)
	const nonEmptyGroups = wordGroups.filter((g) => g.fstToken !== "")

	if (nonEmptyGroups.length < 2) return { matrix, transitionAdjustments } // Need two disjoint candidates.

	const probeMode: PlacetypePairProbeMode = opts.probeMode ?? "auto"
	// Segment ids are only needed for segment/auto paths.
	const needsSegments = probeMode === "segment" || probeMode === "auto"
	const groupSegments = needsSegments ? computeGroupSegments(nonEmptyGroups, pieces, opts.inputText) : undefined
	// Segment path may strip trailing same-field postcode from parent key.
	const parentPostcodeShape = needsSegments ? segmentParentPostcodeShape(index.country) : undefined

	// Leading-postcode handling is enabled only for configured countries.
	const leadingPostcodeShape =
		needsSegments && index.country && LEADING_POSTCODE_COUNTRIES.has(index.country.toLowerCase())
			? parentPostcodeShape
			: undefined

	const segmentWindows = groupSegments
		? buildSegmentWindows(nonEmptyGroups, groupSegments, parentPostcodeShape, leadingPostcodeShape)
		: undefined

	// Auto mode falls back to anchored when segment mode cannot form a pair.
	if (probeMode === "anchored" || (probeMode === "auto" && segmentWindows!.length < 2)) {
		const parentEnd = resolveAnchorParentEnd(nonEmptyGroups, pieces, opts.inputText)

		// No room for child to the left.
		if (parentEnd < 1) return { matrix, transitionAdjustments }

		const hit = probeAnchoredAdjacentPair(index, nonEmptyGroups, parentEnd, recordCensusParent)

		if (hit) {
			recordFiredChildTag(opts.probeTrace, hit.edge.tag)

			applyWindowBias(
				nonEmptyGroups,
				matrix,
				labelToCol,
				hit.child,
				hit.edge.tag,
				bias,
				transitionBeta,
				transitionAdjustments
			)

			if (parentDelta !== undefined) {
				applyParentTagBias(matrix, labelToCol, hit.parent, hit.edge.parentTag, parentDelta)
			}

			if (opts.probeTrace) {
				opts.probeTrace.firedPath = "anchored"
			}
		}

		return { matrix, transitionAdjustments }
	}

	const windows = probeMode === "window" ? buildWindows(nonEmptyGroups, WINDOW_MAX_WORDS) : segmentWindows!

	// Need at least two candidates before pair search.
	if (windows.length < 2) return { matrix, transitionAdjustments }

	let anyApplied = false

	for (let wi = 0; wi < windows.length; wi++) {
		const x = windows[wi]!

		if (isMarkerSuppressed(nonEmptyGroups, x, groupSegments)) continue

		// Segment identity-repeat rule: repeated adjacent equal segments skip identity partners.
		const previous = probeMode !== "window" && wi > 0 ? windows[wi - 1]! : undefined
		const isIdentityRepeat = previous !== undefined && previous.endPos + 1 === x.startPos && sharesFoldForm(previous, x)

		let matchedEdge: PairEdge | undefined
		// Keep parent window from hit for optional parent bias.
		let matchedParent: CandidateWindow | undefined

		for (const y of windows) {
			if (!disjoint(x, y)) continue

			if (isIdentityRepeat && sharesFoldForm(x, y)) continue

			const edge = probeWindowPair(index, x, y, recordCensusParent)

			if (edge) {
				matchedEdge = edge
				matchedParent = y

				break
			}
		}

		if (!matchedEdge) continue

		recordFiredChildTag(opts.probeTrace, matchedEdge.tag)

		applyWindowBias(nonEmptyGroups, matrix, labelToCol, x, matchedEdge.tag, bias, transitionBeta, transitionAdjustments)

		if (parentDelta !== undefined) {
			applyParentTagBias(matrix, labelToCol, matchedParent!, matchedEdge.parentTag, parentDelta)
		}

		anyApplied = true
	}

	if (anyApplied && opts.probeTrace) {
		opts.probeTrace.firedPath = probeMode === "window" ? "window" : "segment"
	}

	return { matrix, transitionAdjustments }
}
