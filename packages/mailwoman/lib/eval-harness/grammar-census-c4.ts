/**
 * Threshold-free, report-only observations for decoder-grammar constraint C4.
 *
 * A phrase proposal is evidence, not a constraint. Overlapping proposals are retained verbatim and this module never
 * turns their presence into a binary violation. It records every adjacent decoded span boundary and the structural
 * evidence available at that boundary so a census can measure which combinations distinguish wrong splits from legal
 * component edges.
 */

/* oxlint-disable sister-software/multiline-statement-padding -- feature-vector records stay adjacent as one receipt */

import type { PhraseProposal } from "@mailwoman/core/pipeline"
import type { FSTAcceptedMatch } from "@mailwoman/neural/fst-prior"
import type { QueryShape } from "@mailwoman/query-shape"

import type { CensusSpan } from "#eval-harness/grammar-census"

export interface CensusPiece {
	start: number
	end: number
}

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
	matches: ReadonlyArray<FSTAcceptedMatch> | undefined,
	boundary: number
): FSTEdgeReceipt[] | null {
	if (!matches) return null

	return matches.flatMap((match) => {
		const edge = match.startPiece === boundary ? "start" : match.endPiece === boundary ? "end" : null

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
 * `undefined` FST matches mean the corresponding license source was unavailable. An empty array means it was available
 * and had no edge at this boundary. Those two states remain distinct in both receipts and aggregation.
 */
export function observeC4Boundaries(
	spans: ReadonlyArray<CensusSpan>,
	pieces: ReadonlyArray<CensusPiece>,
	phraseProposals: ReadonlyArray<PhraseProposal>,
	shape: QueryShape,
	registryMatches?: ReadonlyArray<FSTAcceptedMatch>,
	streetAffixMatches?: ReadonlyArray<FSTAcceptedMatch>
): C4BoundaryReceipt[] {
	const ordered = spans.toSorted((a, b) => a.start - b.start || a.end - b.end)
	const receipts: C4BoundaryReceipt[] = []

	for (let index = 1; index < ordered.length; index++) {
		const left = ordered[index - 1]!
		const right = ordered[index]!

		if (left.end !== right.start) continue

		const boundaryPiece = left.end
		const leftPiece = pieces[boundaryPiece - 1]
		const rightPiece = pieces[boundaryPiece]

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
			streetAffixEdges: fstEdgesAtBoundary(streetAffixMatches, boundaryPiece),
			registryFSTEdges: fstEdgesAtBoundary(registryMatches, boundaryPiece),
		})
	}

	return receipts
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
 * Representative full-input receipts printed per feature vector; the JSON row ledger remains complete.
 */
const FEATURE_VECTOR_EXAMPLE_LIMIT = 3

/**
 * Aggregate exact structural-presence vectors. Proposal confidence remains in row receipts and is never thresholded.
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
			`street_affix=${boundary.streetAffixEdges === null ? "unavailable" : boundary.streetAffixEdges.length ? "yes" : "no"}`,
			`registry_fst=${boundary.registryFSTEdges === null ? "unavailable" : boundary.registryFSTEdges.length ? "yes" : "no"}`,
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
