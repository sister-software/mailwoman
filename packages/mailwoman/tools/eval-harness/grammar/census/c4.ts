/**
 * Threshold-free, report-only observations for decoder-grammar constraint C4.
 *
 * A phrase proposal is evidence rather than a constraint.
 * The census retains overlaps verbatim.
 * It never treats their presence as a binary violation.
 *
 * It records every adjacent decoded span boundary and the structural evidence available
 * at that boundary so a census can measure which combinations distinguish wrong splits
 * from legal component edges. {@linkcode classifyC4Boundary} applies §5's predicate
 * to a receipt as written and leaves the receipt unchanged.
 */

/* oxlint-disable sister-software/multiline-statement-padding -- feature-vector records stay adjacent as one receipt */

import type { PhraseProposal } from "@mailwoman/core/pipeline"
import type { FSTAcceptedMatch } from "@mailwoman/neural/fst-prior"
import type { CharRange, QueryShape } from "@mailwoman/query-shape"

import { adjacentSpanPairs, type CensusSpan } from "#tools/eval-harness/grammar/census"

export interface PhraseBoundaryReceipt {
	kind: PhraseProposal["kindHypothesis"]
	confidence: number
	start: number
	end: number
}

export interface SegmentEdgeReceipt {
	separator: string | null
	leftSegmentEnd: number
	rightSegmentStart: number
}

export interface CharacterClassChangeReceipt {
	from: QueryShape["tokenClasses"][number]["class"]
	to: QueryShape["tokenClasses"][number]["class"]
}

export interface KnownFormatEdgeReceipt {
	format: QueryShape["knownFormats"][number]["format"]
	confidence: number
	edge: "start" | "end"
}

export interface FSTEdgeReceipt {
	startPiece: number
	endPiece: number
	edge: "start" | "end"
	entries: Array<{ wofID: number; placetype: string; referential: number }>
}

export interface C4BoundaryReceipt {
	boundaryPiece: number
	boundaryCharacter: number
	leftCharacter: number
	rightCharacter: number
	left: CensusSpan
	right: CensusSpan
	insidePhraseProposals: PhraseBoundaryReceipt[]
	delimiterSegmentEdges: SegmentEdgeReceipt[]
	characterClassChange: CharacterClassChangeReceipt | null
	knownFormatEdges: KnownFormatEdgeReceipt[]
	streetAffixEdges: FSTEdgeReceipt[] | null
	registryFSTEdges: FSTEdgeReceipt[] | null
}

function fstEdgesAtBoundary(
	matches: ReadonlyArray<FSTAcceptedMatch> | null,
	leftEnd: number,
	rightStart: number
): FSTEdgeReceipt[] | null {
	if (!matches) return null

	return matches.flatMap((match) => {
		const edge = match.startPiece === rightStart ? "start" : match.endPiece === leftEnd ? "end" : null

		if (!edge) return []

		return [
			{
				startPiece: match.startPiece,
				endPiece: match.endPiece,
				edge,
				entries: match.entries.map((entry) => ({
					wofID: entry.wofID,
					placetype: entry.placetype,
					referential: entry.referential,
				})),
			},
		]
	})
}

function tokenClassAt(shape: QueryShape, character: number) {
	return shape.tokenClasses.find((token) => token.span.start <= character && character < token.span.end)
}

/**
 * Record every boundary between adjacent decoded, non-O spans.
 *
 * Spans separated only by `blankPieces` count as adjacent, and the boundary is the right span's first piece.
 *
 * `undefined` FST matches mean the corresponding license source was unavailable.
 * An empty array means it was available and had no edge at this boundary.
 *
 * Those two states remain distinct in both receipts and aggregation.
 */
export function observeC4Boundaries(
	spans: ReadonlyArray<CensusSpan>,
	pieces: ReadonlyArray<CharRange>,
	phraseProposals: ReadonlyArray<PhraseProposal>,
	shape: QueryShape,
	registryMatches?: ReadonlyArray<FSTAcceptedMatch> | null,
	streetAffixMatches?: ReadonlyArray<FSTAcceptedMatch> | null,
	blankPieces: ReadonlySet<number> = new Set()
): C4BoundaryReceipt[] {
	const receipts: C4BoundaryReceipt[] = []

	for (const [left, right] of adjacentSpanPairs(spans, blankPieces)) {
		const boundaryPiece = right.start
		const leftPiece = pieces[left.end - 1]
		const rightPiece = pieces[right.start]

		if (!leftPiece || !rightPiece) continue

		const leftCharacter = leftPiece.end
		const rightCharacter = rightPiece.start
		const boundaryCharacter = rightCharacter
		const leftClass = tokenClassAt(shape, Math.max(0, leftCharacter - 1))
		const rightClass = tokenClassAt(shape, rightCharacter)
		const characterClassChange =
			leftClass && rightClass && leftClass.class !== rightClass.class
				? { from: leftClass.class, to: rightClass.class }
				: null

		const delimiterSegmentEdges: SegmentEdgeReceipt[] = []

		for (let segmentIndex = 1; segmentIndex < shape.segments.length; segmentIndex++) {
			const previous = shape.segments[segmentIndex - 1]!
			const current = shape.segments[segmentIndex]!

			if (previous.span.end <= current.span.start && current.span.start === rightCharacter) {
				delimiterSegmentEdges.push({
					separator: current.separator,
					leftSegmentEnd: previous.span.end,
					rightSegmentStart: current.span.start,
				})
			}
		}

		const knownFormatEdges: KnownFormatEdgeReceipt[] = []

		for (const hit of shape.knownFormats) {
			if (leftCharacter <= hit.span.start && hit.span.start <= rightCharacter) {
				knownFormatEdges.push({ format: hit.format, confidence: hit.confidence, edge: "start" })
			}

			if (leftCharacter <= hit.span.end && hit.span.end <= rightCharacter) {
				knownFormatEdges.push({ format: hit.format, confidence: hit.confidence, edge: "end" })
			}
		}

		receipts.push({
			boundaryPiece,
			boundaryCharacter,
			leftCharacter,
			rightCharacter,
			left,
			right,
			insidePhraseProposals: phraseProposals
				.filter((proposal) => proposal.span.start < boundaryCharacter && boundaryCharacter < proposal.span.end)
				.map((proposal) => ({
					kind: proposal.kindHypothesis,
					confidence: proposal.confidence,
					start: proposal.span.start,
					end: proposal.span.end,
				})),
			delimiterSegmentEdges,
			characterClassChange,
			knownFormatEdges,
			streetAffixEdges: fstEdgesAtBoundary(streetAffixMatches ?? null, left.end, right.start),
			registryFSTEdges: fstEdgesAtBoundary(registryMatches ?? null, left.end, right.start),
		})
	}

	return receipts
}

/**
 * The four licenses `decoder-grammar.mdx` §5 names for a C4 boundary.
 */
export const C4_LICENSES = ["delimiter", "affix_lexeme", "character_class", "registry_edge"] as const

/**
 * One license from {@linkcode C4_LICENSES}.
 */
export type C4License = (typeof C4_LICENSES)[number]

/**
 * The C4 reading of one boundary receipt.
 *
 * - `outside_phrase`: no phrase proposal holds the boundary strictly inside it, so C4 does not apply.
 * - `licensed`: at least one §5 license holds at the boundary.
 * - `violation`: the boundary is inside a phrase proposal and no license holds.
 * - `unmeasured`: no license holds among the sources read, and an affix or registry source was not read.
 */
export type C4Verdict = "outside_phrase" | "licensed" | "violation" | "unmeasured"

export interface C4BoundaryClassification {
	/**
	 * The verdict with a phrase-grouper proposal as the phrase, the input §5 names.
	 */
	verdict: C4Verdict
	/**
	 * The verdict with the comma-free query-shape segment as the phrase.
	 *
	 * Every boundary that is not on a delimiter lies inside one, so this verdict is never `outside_phrase`.
	 * It differs from {@link verdict} where the grouper proposes no phrase across the boundary.
	 */
	segmentVerdict: Exclude<C4Verdict, "outside_phrase">
	licenses: C4License[]
	unreadSources: Array<"street_affix" | "registry_fst">
}

/**
 * Apply §5's C4 predicate to one boundary receipt: a span boundary interior to a delimiter-free phrase
 * is licensed by a delimiter, an affix lexeme, a character-class change, or a registry match edge.
 *
 * A phrase is a phrase-grouper proposal holding the boundary strictly inside it.
 * A delimiter is a query-shape segment edge at the boundary.
 *
 * An affix lexeme is a street-affix match starting or ending there.
 * A character-class change compares the query-shape token classes on either side.
 *
 * A registry match edge is a gazetteer FST match starting or ending there.
 * A known-format edge is outside the four, so it grants no license.
 */
export function classifyC4Boundary(receipt: C4BoundaryReceipt): C4BoundaryClassification {
	const licenses: C4License[] = []

	if (receipt.delimiterSegmentEdges.length) {
		licenses.push("delimiter")
	}

	if (receipt.streetAffixEdges?.length) {
		licenses.push("affix_lexeme")
	}

	if (receipt.characterClassChange) {
		licenses.push("character_class")
	}

	if (receipt.registryFSTEdges?.length) {
		licenses.push("registry_edge")
	}

	const unreadSources: C4BoundaryClassification["unreadSources"] = []

	if (!receipt.streetAffixEdges) {
		unreadSources.push("street_affix")
	}

	if (!receipt.registryFSTEdges) {
		unreadSources.push("registry_fst")
	}

	const segmentVerdict = licenses.length ? "licensed" : unreadSources.length ? "unmeasured" : "violation"
	const verdict: C4Verdict = receipt.insidePhraseProposals.length ? segmentVerdict : "outside_phrase"

	return { verdict, segmentVerdict, licenses, unreadSources }
}

export type C4TruthPosition = "inside_expected_component" | "expected_component_edge" | "unclassified"

export interface ClassifiedC4BoundaryReceipt extends C4BoundaryReceipt {
	rowID: string
	input: string
	truthPosition: C4TruthPosition
}

export interface C4FeatureVectorCount {
	featureVector: string
	total: number
	insideExpectedComponent: number
	expectedComponentEdge: number
	unclassified: number
	examples: Array<{ rowID: string; input: string }>
}

/**
 * Representative full-input receipts printed per feature vector.
 * The JSON row ledger remains complete.
 */
const FEATURE_VECTOR_EXAMPLE_LIMIT = 3

/**
 * Aggregate exact structural-presence vectors.
 *
 * Proposal confidence remains in row receipts and is never thresholded.
 */
export function summarizeC4FeatureVectors(
	boundaries: ReadonlyArray<ClassifiedC4BoundaryReceipt>
): C4FeatureVectorCount[] {
	const counts = new Map<string, C4FeatureVectorCount>()

	for (const boundary of boundaries) {
		const proposalKinds = [...new Set(boundary.insidePhraseProposals.map((proposal) => proposal.kind))].toSorted()
		const featureVector = [
			`phrase=${proposalKinds.length ? proposalKinds.join("+") : "none"}`,
			`segment=${boundary.delimiterSegmentEdges.length ? "yes" : "no"}`,
			`char_class=${boundary.characterClassChange ? `${boundary.characterClassChange.from}>${boundary.characterClassChange.to}` : "no"}`,
			`known_format=${boundary.knownFormatEdges.length ? "yes" : "no"}`,
			`street_affix=${boundary.streetAffixEdges ? (boundary.streetAffixEdges.length ? "yes" : "no") : "unavailable"}`,
			`registry_fst=${boundary.registryFSTEdges ? (boundary.registryFSTEdges.length ? "yes" : "no") : "unavailable"}`,
		].join(";")

		const count = counts.get(featureVector) ?? {
			featureVector,
			total: 0,
			insideExpectedComponent: 0,
			expectedComponentEdge: 0,
			unclassified: 0,
			examples: [],
		}

		count.total++

		if (boundary.truthPosition === "inside_expected_component") {
			count.insideExpectedComponent++
		} else if (boundary.truthPosition === "expected_component_edge") {
			count.expectedComponentEdge++
		} else {
			count.unclassified++
		}

		if (
			count.examples.length < FEATURE_VECTOR_EXAMPLE_LIMIT &&
			!count.examples.some((example) => example.rowID === boundary.rowID)
		) {
			count.examples.push({ rowID: boundary.rowID, input: boundary.input })
		}

		counts.set(featureVector, count)
	}

	return [...counts.values()].toSorted((a, b) => b.total - a.total || a.featureVector.localeCompare(b.featureVector))
}
