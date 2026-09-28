/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from `QueryShape`: when the query-shape subsystem has
 *   identified a known-format span (US ZIP, UK postcode, PO box, etc.) this module produces an
 *   additive bias matrix that nudges the encoder's per-token emissions toward the matching BIO
 *   label without overriding the encoder, which stays the authority on context-dependent calls.
 *
 *   The `QueryShape` value is consumed structurally and the format-name convention is imported from
 *   its owner rather than restated, because a restated convention drops the formats added after it.
 */

import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"

import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import { spansOverlap } from "#span/repair"

/**
 * Candidate count above which the shape prior is too diffuse to be worth applying.
 */
const MAX_PRIOR_CANDIDATES = 4

export interface QueryShapeLike {
	knownFormats: ReadonlyArray<KnownFormatHitLike>
	regionAbbreviations?: ReadonlyArray<RegionAbbreviationHitLike>
}

interface RegionAbbreviationHitLike {
	start: number
	span: string
}

export interface KnownFormatHitLike {
	format: string
	span: { start: number; end: number }
	/**
	 * Confidence in 0..1; ambiguous patterns (5-digit US/FR/DE overlap) score lower.
	 */
	confidence: number
}

/**
 * Minimal subset of `TokenizedPiece` this module consumes.
 */
export interface TokenLike {
	start: number
	end: number
}

/**
 * The BIO label a non-postcode `KnownFormat` biases; postcode formats are decided by name through
 * {@linkcode isPostcodeFormat}, so a format added to the detector's table reaches this prior
 * without a second list to keep in step.
 */
const FORMAT_TO_LABEL: ReadonlyMap<string, string> = new Map([["po_box", "B-po_box"]])

/**
 * The BIO label {@linkcode buildEmissionPriors} biases for one format hit, or `undefined` when the
 * format names no label; an uncovered format contributes zero bias and raises no error.
 */
function formatLabel(format: string): string | undefined {
	return isPostcodeFormat(format) ? "B-postcode" : FORMAT_TO_LABEL.get(format)
}

export interface BuildPriorsOpts {
	/**
	 * Maximum bias magnitude in log-odds units, default 1.0 and scaled by hit confidence.
	 */
	biasScale?: number
	/**
	 * Raw input text, without which the scoped locality bias's digit guard cannot run.
	 */
	inputText?: string
}

/**
 * Build a `[seqLen][numLabels]` matrix of additive log-bias for encoder emissions before Viterbi
 * decoding, where each token overlapping a format hit receives `hit.confidence × biasScale` on the
 * format's mapped label and the matrix is all zeros when `shape.knownFormats` is empty.
 */
export function buildEmissionPriors(
	shape: QueryShapeLike,
	tokens: ReadonlyArray<TokenLike>,
	labels: ReadonlyArray<string>,
	opts: BuildPriorsOpts = {}
): number[][] {
	const T = tokens.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1
	const matrix = emptyPriorMatrix(T, L)
	const labelToCol = labelColumnIndex(labels)

	if (!shape.knownFormats.length && !shape.regionAbbreviations?.length) {
		return matrix
	}

	for (const hit of shape.knownFormats) {
		const targetLabel = formatLabel(hit.format)

		if (!targetLabel) continue
		const col = labelToCol.get(targetLabel)

		if (col === undefined) continue
		const bias = hit.confidence * biasScale

		for (let t = 0; t < T; t++) {
			const tok = tokens[t]!

			if (spansOverlap(tok, hit.span)) {
				matrix[t]![col] = Math.max(matrix[t]![col]!, bias)
			}
		}
	}

	applyScopedLocalityBias(matrix, shape, tokens, labelToCol, opts.inputText)

	return matrix
}

/**
 * The scoped locality bias, which fires only on the bare admin doubleton (a region-ambiguous name
 * immediately before its abbreviation) and only when the input holds no digits, the abbreviation is
 * the final token, and at most {@link MAX_PRIOR_CANDIDATES} tokens precede it.
 */
function applyScopedLocalityBias(
	matrix: number[][],
	shape: QueryShapeLike,
	tokens: ReadonlyArray<TokenLike>,
	labelToCol: Map<string, number>,
	inputText?: string
): void {
	const abbrevs = shape.regionAbbreviations

	if (!abbrevs?.length || !inputText || /\d/.test(inputText)) return

	const bLocCol = labelToCol.get("B-locality")
	const iLocCol = labelToCol.get("I-locality")

	if (bLocCol === undefined) return

	for (const abbrev of abbrevs) {
		if (tokens.some((tok) => tok.start > abbrev.start + abbrev.span.length)) continue

		const candidates = tokens.map((tok, t) => ({ tok, t })).filter(({ tok }) => tok.end <= abbrev.start)

		if (!candidates.length || candidates.length > MAX_PRIOR_CANDIDATES) continue

		for (let i = 0; i < candidates.length; i++) {
			const col = i === 0 ? bLocCol : iLocCol

			if (col === undefined) continue
			matrix[candidates[i]!.t]![col] = Math.max(matrix[candidates[i]!.t]![col]!, SCOPED_LOCALITY_BIAS)
		}
	}
}

/**
 * Log-odds bias for the scoped doubleton case.
 */
const SCOPED_LOCALITY_BIAS = 2

/**
 * Element-wise add two matrices of equal shape, returning a new matrix.
 */
export function addEmissionMatrix(emissions: number[][], priors: number[][]): number[][] {
	if (!priors.length) return emissions.map((row) => row.slice())
	const out: number[][] = []

	for (let t = 0; t < emissions.length; t++) {
		const e = emissions[t]!
		const p = priors[t] ?? new Array<number>(e.length).fill(0)
		const row = new Array<number>(e.length)

		for (let k = 0; k < e.length; k++) {
			row[k] = e[k]! + (p[k] ?? 0)
		}

		out.push(row)
	}

	return out
}
