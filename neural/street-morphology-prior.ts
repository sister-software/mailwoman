/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-morphology emission bias — Layer 1 of the four-layer street-supplement architecture (see
 *   `docs/articles/concepts/street-supplement-architecture.md`).
 *
 *   This module composes with {@linkcode buildFSTEmissionPriors} (admin FST) and the QueryShape prior
 *   via {@linkcode addEmissionMatrix} — same shape, same additive semantics. Where the admin FST
 *   biases admin BIO labels (`B/I-locality`, `B/I-region`, ...), the morphology FST biases:
 *
 *   - **Affix-token (the matched span):** toward `B/I-street_prefix` AND `B/I-street_suffix` (position
 *       unknown — let the model + context disambiguate).
 *   - **Adjacent token (one before AND one after each match):** toward `B/I-street`, AWAY from
 *       `B/I-dependent_locality`. The negative bias on `dependent_locality` is the essential piece
 *       — it closes the inference-time vacuum that caused v0.6.1's 1066 dep_locality hallucinations
 *       (see [[project-v061-failure-mechanism]]).
 *
 *   The morphology FST itself is built by `resolver-wof-sqlite/street-morphology-fst-builder.ts` and
 *   ships as a separate binary (`fst-street-morphology.bin`) loaded into a second `FSTMatcher`
 *   instance.
 */

import { groupPiecesIntoWords, type FSTMatcherLike, type WordGroup } from "./fst-prior.ts"
import type { TokenLike } from "./query-shape-prior.ts"

export interface StreetMorphologyPriorOpts {
	/** Multiplier on the base bias before {@linkcode maxBias} is applied. Default 1.0. */
	biasScale?: number
	/**
	 * Maximum bias magnitude (logits) on the affix span itself. Default 3.0 — same as the admin FST. The morphology
	 * signal is structurally less ambiguous than admin names (`Avenue` is almost never anything but street-typing), so
	 * equal magnitude is justified.
	 */
	maxAffixBias?: number
	/**
	 * Maximum bias magnitude (logits) on the adjacent (neighbour) tokens for the `street` label. Default 2.0 — a touch
	 * weaker than the affix bias because the neighbour is inferred from adjacency, not direct match.
	 */
	maxNeighbourStreetBias?: number
	/**
	 * Magnitude of the negative bias applied to `dependent_locality` BIO labels on the adjacent tokens. Default 2.0. This
	 * is the essential piece.
	 */
	dependentLocalityPenalty?: number
}

/**
 * Build a `[seqLen][numLabels]` bias matrix from street-morphology FST matches.
 *
 * The output composes with the admin FST bias matrix via {@linkcode addEmissionMatrix} — same
 * `addEmissionMatrix(emissions, fstBias) → biasedEmissions` pattern as the existing admin prior.
 */
export function buildStreetMorphologyEmissionPriors(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: StreetMorphologyPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1.0
	const maxAffixBias = opts.maxAffixBias ?? 3.0
	const maxNeighbourStreetBias = opts.maxNeighbourStreetBias ?? 2.0
	const dependentLocalityPenalty = opts.dependentLocalityPenalty ?? 2.0

	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}

	const bStreetPrefix = labelToCol.get("B-street_prefix")
	const iStreetPrefix = labelToCol.get("I-street_prefix")
	const bStreetSuffix = labelToCol.get("B-street_suffix")
	const iStreetSuffix = labelToCol.get("I-street_suffix")
	const bStreet = labelToCol.get("B-street")
	const iStreet = labelToCol.get("I-street")
	const bDepLoc = labelToCol.get("B-dependent_locality")
	const iDepLoc = labelToCol.get("I-dependent_locality")

	// If the label vocabulary doesn't include street tags at all (e.g. a Stage 1 model), there's
	// nothing to bias toward. Return zero-matrix and let the additive pipeline no-op.
	if (bStreet === undefined || bStreetPrefix === undefined || bStreetSuffix === undefined) {
		return matrix
	}

	const wordGroups = groupPiecesIntoWords(pieces)

	if (wordGroups.length === 0) return matrix

	// Track which word-group indices are matched as affixes (and which spans they cover) so the
	// second pass can locate neighbours without re-walking the FST.
	interface AffixMatch {
		startGroupIdx: number
		endGroupIdx: number // inclusive
	}
	const affixMatches: AffixMatch[] = []

	// Pass 1 — walk every contiguous subpath, collect accepting morphology matches, and apply
	// the affix bias to matched tokens.
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

		// Verify the accepting entries are street_affix (the morphology FST may eventually contain
		// other placetypes if the binary format is reused for related priors).
		const entries = fst.accepting(bestStateID)
		const hasAffix = entries.some((e) => e.placetype === "street_affix")

		if (!hasAffix) continue

		affixMatches.push({ startGroupIdx: start, endGroupIdx: bestEnd })

		// Collect piece indices for the matched span.
		const affixPieceIndices: number[] = []

		for (let g = start; g <= bestEnd; g++) {
			const wg = wordGroups[g]!

			if (wg.fstToken === "") continue

			for (const pi of wg.pieceIndices) {
				affixPieceIndices.push(pi)
			}
		}

		// Apply affix bias: positive bias toward both prefix and suffix BIO labels on the matched
		// tokens. The model's existing logits + the QueryShape prior + the adjacent context (via
		// pass 2) determine which of {prefix, suffix} actually wins. We don't pre-commit to one.
		const affixBias = biasScale * maxAffixBias

		for (let k = 0; k < affixPieceIndices.length; k++) {
			const pi = affixPieceIndices[k]!
			const prefixCol = k === 0 ? bStreetPrefix : (iStreetPrefix ?? bStreetPrefix)
			const suffixCol = k === 0 ? bStreetSuffix : (iStreetSuffix ?? bStreetSuffix)
			matrix[pi]![prefixCol] = Math.max(matrix[pi]![prefixCol]!, affixBias)
			matrix[pi]![suffixCol] = Math.max(matrix[pi]![suffixCol]!, affixBias)
		}
	}

	if (affixMatches.length === 0) return matrix

	// Pass 2 — for each affix match, identify the immediately-adjacent word groups (skipping
	// empty/punctuation groups) on either side and bias them toward street, away from
	// dependent_locality.
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
 * Walk word groups outward from `fromGroupIdx` in `direction` (+1 or -1), skipping empty groups (whitespace /
 * punctuation), and return the first non-empty group encountered — or `null` if no such neighbour exists.
 */
function findNeighbour(groups: WordGroup[], fromGroupIdx: number, direction: 1 | -1): WordGroup | null {
	for (let i = fromGroupIdx + direction; i >= 0 && i < groups.length; i += direction) {
		const g = groups[i]!

		if (g.fstToken !== "") return g
	}

	return null
}
