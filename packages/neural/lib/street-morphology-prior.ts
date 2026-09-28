/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-morphology emission bias — Layer 1 of the four-layer street-supplement architecture (see
 *   `docs/articles/concepts/street-supplement-architecture.md`).
 *
 *   It composes with {@linkcode buildFSTEmissionPriors} (admin FST) and the QueryShape prior via
 *   {@linkcode addEmissionMatrix}: where the admin FST biases `B/I-locality`, `B/I-region`, ..., this
 *   biases the matched affix span toward `B/I-street_prefix` and `B/I-street_suffix` and the
 *   adjacent tokens toward `B/I-street` and away from `B/I-dependent_locality`, the negative bias
 *   that closes the inference-time vacuum behind dep_locality hallucination.
 *
 *   The morphology FST binary (`fst-street-morphology.bin`) is built by
 *   `resolver-wof-sqlite/street-morphology-fst-builder.ts` and loaded into a second `FSTMatcher`.
 */

import { groupPiecesIntoWords, type FSTMatcherLike, type WordGroup } from "#fst-prior"
import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import type { TokenLike } from "#query-shape-prior"

export interface StreetMorphologyPriorOpts {
	/**
	 * Multiplier on the base bias before {@linkcode maxBias} is applied.
	 * Default 1.0.
	 */
	biasScale?: number
	/**
	 * Maximum bias magnitude (logits) on the affix span itself, default 3.0 — equal to the
	 * admin FST because the morphology signal is structurally less ambiguous.
	 */
	maxAffixBias?: number
	/**
	 * Maximum bias magnitude (logits) on adjacent tokens for the `street` label, default 2.0 —
	 * weaker than the affix bias because the neighbour is inferred from adjacency rather than matched.
	 */
	maxNeighbourStreetBias?: number
	/**
	 * Magnitude of the negative bias on `dependent_locality` BIO labels for adjacent tokens, default 2.0.
	 */
	dependentLocalityPenalty?: number
}

/**
 * Build a `[seqLen][numLabels]` bias matrix from street-morphology FST matches,
 * composing with the admin FST bias matrix through {@linkcode addEmissionMatrix}.
 */
export function buildStreetMorphologyEmissionPriors(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: StreetMorphologyPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1
	const maxAffixBias = opts.maxAffixBias ?? 3
	const maxNeighbourStreetBias = opts.maxNeighbourStreetBias ?? 2
	const dependentLocalityPenalty = opts.dependentLocalityPenalty ?? 2

	const matrix = emptyPriorMatrix(T, L)
	const labelToCol = labelColumnIndex(labels)

	const bStreetPrefix = labelToCol.get("B-street_prefix")
	const iStreetPrefix = labelToCol.get("I-street_prefix")
	const bStreetSuffix = labelToCol.get("B-street_suffix")
	const iStreetSuffix = labelToCol.get("I-street_suffix")
	const bStreet = labelToCol.get("B-street")
	const iStreet = labelToCol.get("I-street")
	const bDepLoc = labelToCol.get("B-dependent_locality")
	const iDepLoc = labelToCol.get("I-dependent_locality")

	// A vocabulary without street tags leaves no label to bias, so the zero matrix no-ops the pipeline.
	if (bStreet === undefined || bStreetPrefix === undefined || bStreetSuffix === undefined) {
		return matrix
	}

	const wordGroups = groupPiecesIntoWords(pieces)

	if (!wordGroups.length) return matrix

	// Track matched word-group spans so the neighbour pass needs no second FST walk.
	interface AffixMatch {
		startGroupIdx: number
		endGroupIdx: number // inclusive
	}

	const affixMatches: AffixMatch[] = []

	for (let start = 0; start < wordGroups.length; start++) {
		const group = wordGroups[start]!

		if (group.fstToken === "") continue

		const initial = fst.walk([group.fstToken])

		if (!initial) continue

		let bestEnd = -1
		let bestStateID = -1

		if (initial.accepted) {
			bestEnd = start
			bestStateID = initial.stateID
		}

		let current = initial

		for (let end = start + 1; end < wordGroups.length; end++) {
			const nextGroup = wordGroups[end]!

			if (nextGroup.fstToken === "") continue

			const next = fst.walkFrom(current, nextGroup.fstToken)

			if (!next) break

			if (next.accepted) {
				bestEnd = end
				bestStateID = next.stateID
			}

			current = next
		}

		if (bestEnd === -1) continue

		// The FST may hold other placetypes if its binary format is reused for related priors.
		const entries = fst.accepting(bestStateID)
		const hasAffix = entries.some((e) => e.placetype === "street_affix")

		if (!hasAffix) continue

		affixMatches.push({ startGroupIdx: start, endGroupIdx: bestEnd })

		const affixPieceIndices: number[] = []

		for (let g = start; g <= bestEnd; g++) {
			const wg = wordGroups[g]!

			if (wg.fstToken === "") continue

			for (const pi of wg.pieceIndices) {
				affixPieceIndices.push(pi)
			}
		}

		// Bias both prefix and suffix BIO labels on the matched tokens rather than pre-committing to one.
		const affixBias = biasScale * maxAffixBias

		for (let k = 0; k < affixPieceIndices.length; k++) {
			const pi = affixPieceIndices[k]!
			const prefixCol = k === 0 ? bStreetPrefix : (iStreetPrefix ?? bStreetPrefix)
			const suffixCol = k === 0 ? bStreetSuffix : (iStreetSuffix ?? bStreetSuffix)
			matrix[pi]![prefixCol] = Math.max(matrix[pi]![prefixCol]!, affixBias)
			matrix[pi]![suffixCol] = Math.max(matrix[pi]![suffixCol]!, affixBias)
		}
	}

	if (!affixMatches.length) return matrix

	const neighbourStreetBias = biasScale * maxNeighbourStreetBias

	for (const match of affixMatches) {
		const before = findNeighbour(wordGroups, match.startGroupIdx, -1)
		const after = findNeighbour(wordGroups, match.endGroupIdx, +1)

		for (const neighbour of [before, after]) {
			if (!neighbour) continue
			const indices = neighbour.pieceIndices

			for (let k = 0; k < indices.length; k++) {
				const pi = indices[k]!
				const streetCol = k === 0 ? bStreet : (iStreet ?? bStreet)
				matrix[pi]![streetCol] = Math.max(matrix[pi]![streetCol]!, neighbourStreetBias)

				if (bDepLoc !== undefined) {
					const depLocCol = k === 0 ? bDepLoc : (iDepLoc ?? bDepLoc)
					matrix[pi]![depLocCol] = Math.min(matrix[pi]![depLocCol]!, -dependentLocalityPenalty)
				}
			}
		}
	}

	return matrix
}

/**
 * Walk word groups outward from `fromGroupIdx` in `direction`, skipping empty groups
 * (whitespace / punctuation), and return the first non-empty neighbour or `null`.
 */
function findNeighbour(groups: WordGroup[], fromGroupIdx: number, direction: 1 | -1): WordGroup | null {
	for (let i = fromGroupIdx + direction; i >= 0 && i < groups.length; i += direction) {
		const g = groups[i]!

		if (g.fstToken !== "") return g
	}

	return null
}
