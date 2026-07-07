/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emission priors from Stage 2.7 span proposals — the consumption half of M2+M3 (the phrase-prior
 *   path the sub-premise direction note names: "consumed as phrase priors today — the classifier
 *   conditions on the boundary hypothesis and can still disagree").
 *
 *   Same contract as `query-shape-prior.ts`: an additive `[seqLen][numLabels]` log-bias matrix
 *   composed onto the encoder emissions before Viterbi. Soft by construction — a confident encoder
 *   wins; an uncertain one gets pulled toward the proposal's reading. Dual-path alternatives (M3)
 *   simply contribute competing biases at their respective confidences; the CRF resolves them
 *   against the model's own evidence, which IS the deferred decision the survey prescribes.
 *
 *   Mapping:
 *
 *   - `ANNOTATION_SPAN` → bias toward `O` (gold convention 2: bracketed asides are not components; the
 *       win is that neighbors stop being poisoned). Applied only above a confidence floor so
 *       trailing component-shaped groups ("(Australia)") are left to the model.
 *   - `QUOTED_SPAN` → no bias. The content is a real name; typing it is the classifier's job. The span
 *       still matters decode-side (the bridge's crossing constraint).
 *   - `PO_BOX_PHRASE` → `po_box`; `UNIT_PHRASE`/`LEVEL_PHRASE`/`SPLIT_UNIT` → `unit` (the schema has no
 *       level tag — levels ride `unit` until the codex level sourcing lands, #517);
 *       `SPLIT_HOUSE_NUMBER`/`FUSED_NUMBER` → `house_number`. B- on the first overlapping piece, I-
 *       on the rest.
 */

import type { ProposedSpan } from "@mailwoman/core/pipeline"

import type { TokenLike } from "./query-shape-prior.js"

export interface SpanProposalPriorOpts {
	/**
	 * Bias magnitude for tag-mapped proposals, in log-odds units. Confidence-scaled. Default 5.0 — measured on the
	 * punctuation-stress sweep (2026-06-12, v4.4.0 int8): the proposer's job is to flip CONFIDENTLY-wrong emissions
	 * (fused `2/14` → split), which 1-2-nat query-shape-style scales cannot reach; 5.0 moved slash +11.1 with every other
	 * class flat, and the model still vetoes where its logit gap is larger (the bare `3/45` row stays fused).
	 */
	biasScale?: number
	/**
	 * Bias magnitude for the annotation O-prior. Confidence-scaled. Default 12.0 — deliberately near-mask strength
	 * (measured saturation point on the same sweep: bracketed +9.1, paren regressions zero): a BALANCED bracket pair with
	 * aside-shaped content is the strongest structural cue the proposer has, and the confidence floor (not the scale) is
	 * what protects the component-shaped groups.
	 */
	annotationBiasScale?: number
	/**
	 * Annotation proposals below this confidence contribute NO O-bias (their span still feeds the decode-side crossing
	 * constraint). Default 0.6 — above the trailing-component shape (0.45), below the capitalized mid-string aside
	 * (0.75).
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
 * Build the additive prior matrix for one parse. Returns all-zeros rows for pieces no proposal covers — composes
 * harmlessly via `addEmissionMatrix`.
 */
export function buildSpanProposalPriors(
	proposals: ReadonlyArray<ProposedSpan>,
	tokens: ReadonlyArray<TokenLike>,
	labels: ReadonlyArray<string>,
	opts: SpanProposalPriorOpts = {}
): number[][] {
	const T = tokens.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 5.0
	const annotationBiasScale = opts.annotationBiasScale ?? 12.0
	const annotationFloor = opts.annotationConfidenceFloor ?? 0.6

	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	if (proposals.length === 0) return matrix

	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}
	const oCol = labelToCol.get("O")

	for (const proposal of proposals) {
		if (proposal.kind === "QUOTED_SPAN") continue

		if (proposal.kind === "ANNOTATION_SPAN") {
			if (oCol === undefined || proposal.confidence < annotationFloor) continue
			const bias = proposal.confidence * annotationBiasScale

			for (let t = 0; t < T; t++) {
				if (overlaps(tokens[t]!, proposal)) {
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
		const bias = proposal.confidence * biasScale
		let first = true

		for (let t = 0; t < T; t++) {
			if (!overlaps(tokens[t]!, proposal)) continue
			const col = first ? bCol : iCol
			first = false

			if (col === undefined) continue
			matrix[t]![col] = Math.max(matrix[t]![col]!, bias)
		}
	}

	return matrix
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end
}
