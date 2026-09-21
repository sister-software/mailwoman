/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adds confidence-scaled span-proposal biases to encoder emissions before Viterbi. Annotation spans
 *   bias toward `O`. quoted spans do not bias labels. mapped proposal kinds bias their component tag.
 */

import type { ProposedSpan } from "@mailwoman/core/pipeline"

import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import type { TokenLike } from "#query-shape-prior"
import { spansOverlap } from "#span/repair"

export interface SpanProposalPriorOpts {
	/**
	 * Bias magnitude for tag-mapped proposals in log odds.
	 * Re-evaluate after retraining.
	 */
	biasScale?: number
	/**
	 * Bias magnitude for venue-structure designator proposals.
	 */
	venueStructureBiasScale?: number
	/**
	 * Bias magnitude for the confidence-scaled annotation O-prior.
	 */
	annotationBiasScale?: number
	/**
	 * Annotation proposals below this confidence contribute no O-bias.
	 */
	annotationConfidenceFloor?: number
}

const KIND_TO_TAG: ReadonlyMap<string, string> = new Map([
	["PO_BOX_PHRASE", "po_box"],
	["UNIT_PHRASE", "unit"],
	["LEVEL_PHRASE", "unit"],
	["SPLIT_UNIT", "unit"],
	["SPLIT_HOUSE_NUMBER", "house_number"],
	["FUSED_NUMBER", "house_number"],
])

/**
 * Build the additive prior matrix for one parse.
 *
 * @returns all-zeros rows for pieces no proposal covers — composes harmlessly via `addEmissionMatrix`.
 */
export function buildSpanProposalPriors(
	proposals: ReadonlyArray<ProposedSpan>,
	tokens: ReadonlyArray<TokenLike>,
	labels: ReadonlyArray<string>,
	opts: SpanProposalPriorOpts = {}
): number[][] {
	const T = tokens.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 5
	const venueStructureBiasScale = opts.venueStructureBiasScale ?? 6
	const annotationBiasScale = opts.annotationBiasScale ?? 12
	const annotationFloor = opts.annotationConfidenceFloor ?? 0.6

	const matrix = emptyPriorMatrix(T, L)

	if (!proposals.length) return matrix

	const labelToCol = labelColumnIndex(labels)
	const oCol = labelToCol.get("O")

	for (const proposal of proposals) {
		if (proposal.kind === "QUOTED_SPAN") continue

		if (proposal.kind === "ANNOTATION_SPAN") {
			if (oCol === undefined || proposal.confidence < annotationFloor) continue
			const bias = proposal.confidence * annotationBiasScale

			for (let t = 0; t < T; t++) {
				if (spansOverlap(tokens[t]!, proposal)) {
					matrix[t]![oCol] = Math.max(matrix[t]![oCol]!, bias)
				}
			}

			continue
		}

		const tag = KIND_TO_TAG.get(proposal.kind)

		if (!tag) continue
		const bCol = labelToCol.get(`B-${tag}`)
		const iCol = labelToCol.get(`I-${tag}`)

		if (bCol === undefined) continue
		// Provenance decides the scale — see venueStructureBiasScale for the corpus measurement that forced the split.
		const scale = proposal.source.startsWith("designator:venue-structure") ? venueStructureBiasScale : biasScale
		const bias = proposal.confidence * scale
		let first = true

		for (let t = 0; t < T; t++) {
			if (!spansOverlap(tokens[t]!, proposal)) continue
			const col = first ? bCol : iCol
			first = false

			if (col === undefined) continue
			matrix[t]![col] = Math.max(matrix[t]![col]!, bias)
		}
	}

	return matrix
}
