/**
 * The C4 and C6 predicates of `decoder-grammar.mdx` §5, read together over one completed decode.
 *
 * This module observes a decode.
 * It does not score, repair, or replace it.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"
import { findFSTAcceptedMatches, type FSTAcceptedMatch, type FSTMatcherLike } from "@mailwoman/neural/fst-prior"
import { groupPhrasesSync } from "@mailwoman/phrase-grouper/group"
import { computeQueryShape } from "@mailwoman/query-shape"

import {
	blankOutsidePieces,
	type C6Violation,
	type CensusSpan,
	detectC6Violations,
	spansFromBIO,
} from "#tools/eval-harness/grammar/census"
import {
	type C4BoundaryClassification,
	type C4BoundaryReceipt,
	classifyC4Boundary,
	observeC4Boundaries,
} from "#tools/eval-harness/grammar/census/c4"

/**
 * The registry evidence both predicates read, as accepted FST matches over the decode's pieces.
 *
 * `null` means the source was not read.
 * An empty array means it was read and matched no surface.
 */
export interface ConstraintRegistryMatches {
	registry: FSTAcceptedMatch[] | null
	streetAffix: FSTAcceptedMatch[] | null
}

/**
 * Walk the gazetteer FST and the street-morphology FST over the decode's pieces.
 *
 * The street-morphology matches keep only those with a `street_affix` entry, the affix lexemes C4 names.
 */
export function findConstraintRegistryMatches(
	pieces: ReadonlyArray<{ piece: string }>,
	matchers: { fst: FSTMatcherLike | null; streetMorphology: FSTMatcherLike | null }
): ConstraintRegistryMatches {
	return {
		registry: matchers.fst ? findFSTAcceptedMatches(matchers.fst, pieces) : null,
		streetAffix: matchers.streetMorphology
			? findFSTAcceptedMatches(matchers.streetMorphology, pieces).filter((match) =>
					match.entries.some((entry) => entry.placetype === "street_affix")
				)
			: null,
	}
}

/**
 * The part of a parse trace the predicates read: the decoded text, its pieces and the final labels.
 */
export interface ConstraintDecode {
	text: string
	pieces: ReadonlyArray<{ piece: string; start: number; end: number }>
	tokens: ReadonlyArray<Pick<DecoderToken, "start" | "end"> & { label: string }>
}

export interface C4BoundaryReading extends C4BoundaryReceipt {
	classification: C4BoundaryClassification
	/**
	 * The boundary falls between two adjacent letters or digits of the input, as
	 * when a byte-fallback piece splits one word into two spans.
	 */
	insideWord: boolean
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u

export interface ConstraintReading {
	/**
	 * The decoded spans in piece coordinates, from the final labels.
	 */
	spans: CensusSpan[]
	/**
	 * Every boundary between adjacent decoded spans, with its C4 reading.
	 */
	boundaries: C4BoundaryReading[]
	/**
	 * Boundaries inside a phrase-grouper proposal that hold no license.
	 */
	c4Violations: C4BoundaryReading[]
	/**
	 * Boundaries inside a comma-free segment that hold no license, the wider reading of "phrase".
	 */
	c4SegmentViolations: C4BoundaryReading[]
	/**
	 * Boundaries inside a phrase that hold no license among the sources read while a source went unread.
	 */
	c4Unmeasured: C4BoundaryReading[]
	/**
	 * `null` when the gazetteer FST was not read, so C6 is unmeasured rather than clear.
	 */
	c6Violations: C6Violation[] | null
}

/**
 * Read C4 and C6 over one decode.
 *
 * Two spans separated only by blank outside pieces are adjacent, so a bare `▁` piece the
 * tokenizer emits before a digit or a script change does not hide a boundary.
 */
export function readConstraints(decode: ConstraintDecode, matches: ConstraintRegistryMatches): ConstraintReading {
	const spans = spansFromBIO(decode.tokens)
	const blank = blankOutsidePieces(decode.tokens, decode.text)
	const shape = computeQueryShape(decode.text)
	const proposals = groupPhrasesSync({ raw: decode.text, normalized: decode.text }, shape)

	const boundaries = observeC4Boundaries(
		spans,
		decode.pieces,
		proposals,
		shape,
		matches.registry,
		matches.streetAffix,
		blank
	).map((receipt) => ({
		...receipt,
		classification: classifyC4Boundary(receipt),
		insideWord:
			receipt.leftCharacter === receipt.rightCharacter &&
			WORD_CHARACTER.test(decode.text[receipt.leftCharacter - 1] ?? "") &&
			WORD_CHARACTER.test(decode.text[receipt.rightCharacter] ?? ""),
	}))

	return {
		spans,
		boundaries,
		c4Violations: boundaries.filter((boundary) => boundary.classification.verdict === "violation"),
		c4SegmentViolations: boundaries.filter((boundary) => boundary.classification.segmentVerdict === "violation"),
		c4Unmeasured: boundaries.filter((boundary) => boundary.classification.verdict === "unmeasured"),
		c6Violations: matches.registry ? detectC6Violations(spans, matches.registry, blank) : null,
	}
}
