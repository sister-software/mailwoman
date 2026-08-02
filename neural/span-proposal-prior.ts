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

import type { TokenLike } from "./query-shape-prior.ts"

export interface SpanProposalPriorOpts {
	/**
	 * Bias magnitude for tag-mapped proposals, in LOG-ODDS (nats). Confidence-scaled: a proposal contributes `confidence
	 *
	 * - BiasScale` to its tag's column, added to the encoder's emissions before Viterbi.
	 *
	 * HOW TO READ THIS NUMBER — the part that outlives any particular value. The scale is meaningless on its own; it only
	 * means something against the MODEL'S OWN MARGIN at the piece in question. A proposal flips the decode exactly when
	 *
	 *     confidence * biasScale  >  (logit of the model's preferred label) - (logit of the proposed label)
	 *
	 * So the scale is not tuned to a benchmark score, it is positioned in a WINDOW: strictly above the margins we intend
	 * to overturn, strictly below the margins we intend to respect. Both edges are empirical facts about the trained
	 * network, not about addresses — a retrain moves them, and a scale carried over unexamined is a number that used to
	 * be right. Re-derive after any model change; do not port the constant.
	 *
	 * That framing is what makes the veto real rather than aspirational. The proposer exists to correct CONFIDENTLY wrong
	 * emissions (a fused `2/14` that should split), which is why query-shape's 1–2 nat scales cannot do this job; but a
	 * proposer that outranks every margin would be a rule engine wearing a prior's clothes, and the model would have no
	 * say anywhere.
	 *
	 * MEASURING A MARGIN. `traceParse` returns raw pre-prior `logits` alongside `pieces` and `labels`. For the piece a
	 * proposal covers, the margin is `max(row) - row[labels.indexOf(proposedLabel)]`, and the minimum scale that can flip
	 * it is that margin divided by the proposal's confidence (0.85 for a non-weak designator, 0.5 for a weak one). Doing
	 * this for a handful of intended-flip and intended-veto cases reconstructs the window directly.
	 *
	 * Two properties of the margins are easy to get wrong and worth stating, because both have already produced a false
	 * reading here:
	 *
	 * - Margins are CONTEXT-dependent, not surface-dependent. The same span in two inputs can sit either side of the window
	 *   (measured 2026-08-02: `Terminal 5` carries a 5.01-nat margin before `O'Hare…` and 3.16 before `Heathrow…`). A
	 *   case that passes therefore proves nothing about the same string elsewhere, and a fixture that samples one context
	 *   will certify a fix that is not general.
	 * - A plateau is not stability. Once a scale clears every competing margin the output stops changing, so a sweep
	 *   reading identical at 8, 12, 20 and 40 has only established that nothing else competes — not that the value is
	 *   safely chosen. The informative end of a sweep is the threshold, not the flat.
	 *
	 * DEFAULT 5.0, and why it has stayed there. Measured on the punctuation-stress sweep (2026-06-12, v4.4.0 int8): it
	 * moved slash +11.1 with every other class flat, while leaving the model's veto intact where its margin is larger
	 * (the bare `3/45` row stays fused). Raising it is not a local edit — the scale is GLOBAL across every proposal class
	 * in {@link KIND_TO_TAG}, so a change bought for one class is spent on all of them, and the punctuation veto is the
	 * thing being spent. A class that needs more push wants its own scale, not a bigger shared one.
	 */
	biasScale?: number
	/**
	 * Bias magnitude for proposals led by a VENUE-INTERIOR designator (`source === "designator:venue-structure"`) —
	 * `Concourse B`, `Terminal 5`, `Gate 12`. Same units and same confidence scaling as {@link biasScale}; separate
	 * because the model's margins against `unit` differ sharply by provenance, which is the only thing that ever
	 * justifies a second constant here.
	 *
	 * WHY IT IS NOT JUST A BIGGER {@link biasScale}. Measured over the 200-row punctuation-stress corpus (2026-08-02,
	 * model 7.0.0): raising the SHARED scale from 5 to 6 newly flips 15 proposal-covered pieces, and only one of them is
	 * venue-structure-led. The other fourteen are postal-designator spans absorbing neighbours they should not — a quote
	 * mark and a comma among them (`Office "B" 1200 Industrial Pkwy`, `"O'Shea's Bar & Grill", … (1st floor)`, both with
	 * no `unit` in gold). The sub-venue fix and the punctuation veto are not in tension when the two classes are weighted
	 * apart; they are in direct tension when one number serves both.
	 *
	 * THE WINDOW. Sub-venue identifiers carry 4.6–5.0 nat margins, so the lower edge is ~5.9 after dividing by the 0.85
	 * designator confidence. The upper edge is set by the confound board — surfaces where a venue-structure word appears
	 * WITHOUT being a designator — and the board is largely structural rather than scored: `proposeDesignatorPhrases`
	 * requires an exact standalone token match plus a short identifier, so `Briggate`/`Kirkgate` (one token, no match),
	 * `Gate House` and `Terminal Industrial Estate` (no short identifier) never reach this prior at all. Re-derive both
	 * edges after a retrain; see {@link biasScale} for the method.
	 */
	venueStructureBiasScale?: number
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
	const biasScale = opts.biasScale ?? 5
	const venueStructureBiasScale = opts.venueStructureBiasScale ?? 6
	const annotationBiasScale = opts.annotationBiasScale ?? 12
	const annotationFloor = opts.annotationConfidenceFloor ?? 0.6

	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	if (!proposals.length) return matrix

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
		// Provenance decides the scale — see venueStructureBiasScale for the corpus measurement that forced the split.
		const scale = proposal.source === "designator:venue-structure" ? venueStructureBiasScale : biasScale
		const bias = proposal.confidence * scale
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
