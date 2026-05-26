/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from the FST gazetteer. When the FST finds that a token
 *   sequence matches a known place name (e.g., "New York" → locality + region), this module
 *   produces additive biases that nudge the Viterbi decoder toward the matching BIO labels.
 *
 *   Composes with the QueryShape prior via addEmissionMatrix — same integration point, same
 *   additive semantics.
 *
 *   SentencePiece ↔ FST bridge: SentencePiece pieces are grouped into whitespace words (by the
 *   ▁ sentinel), normalized through the same pipeline as FST edges (NFKC, lowercase, strip
 *   non-alnum), and walked through the FST as contiguous subpaths.
 *
 *   Uses structural typing for the FST input so this module has zero dependencies on
 *   @mailwoman/resolver-wof-sqlite — consumers pass an FstMatcher instance, but this file only
 *   consumes the shape.
 */

import type { TokenLike } from "./query-shape-prior.js"

const SPACE_SENTINEL = "▁"

// ---------------------------------------------------------------------------
// Structural types — compatible with @mailwoman/resolver-wof-sqlite shapes
// ---------------------------------------------------------------------------

export interface FstMatchLike {
	stateId: number
	accepted: boolean
	depth: number
}

export interface FstPlaceEntryLike {
	placetype: string
	population: number
}

export interface FstMatcherLike {
	walk(tokens: string[]): FstMatchLike | null
	walkFrom(prev: FstMatchLike, token: string): FstMatchLike | null
	accepting(stateId: number): FstPlaceEntryLike[]
}

// ---------------------------------------------------------------------------
// Placetype → BIO label mapping
// ---------------------------------------------------------------------------

const PLACETYPE_TO_BIO: ReadonlyMap<string, string> = new Map([
	["country", "country"],
	["region", "region"],
	["locality", "locality"],
	["postalcode", "postcode"],
])

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface WordGroup {
	fstToken: string
	pieceIndices: number[]
}

const SUPPRESS_WHEN_PLACE: readonly string[] = ["B-street", "I-street", "B-house_number", "I-house_number", "B-venue"]

export interface FstPriorOpts {
	biasScale?: number
	/** Maximum bias magnitude (logits). Prevents large-population places from overriding the model. Default 3.0. */
	maxBias?: number
	suppressionScale?: number
}

/**
 * Build a `[seqLen][numLabels]` bias matrix from FST gazetteer matches.
 *
 * Walks all contiguous subpaths of the reconstructed whitespace-token sequence through the FST.
 * For each accepting state, biases the corresponding BIO labels on the matched pieces.
 */
export function buildFstEmissionPriors(
	fst: FstMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: FstPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1.0
	const maxBias = opts.maxBias ?? 3.0
	const suppressionScale = opts.suppressionScale ?? 1.5
	const matrix: number[][] = []
	for (let t = 0; t < T; t++) matrix.push(new Array<number>(L).fill(0))

	const labelToCol = new Map<string, number>()
	for (let k = 0; k < labels.length; k++) labelToCol.set(labels[k]!, k)

	const wordGroups = groupPiecesIntoWords(pieces)
	if (wordGroups.length === 0) return matrix

	for (let start = 0; start < wordGroups.length; start++) {
		const group = wordGroups[start]!
		if (group.fstToken === "") continue

		const match = fst.walk([group.fstToken])
		if (!match) continue

		if (match.accepted) {
			applyBias(matrix, labelToCol, fst.accepting(match.stateId), [group], biasScale, maxBias, suppressionScale)
		}

		let current = match
		for (let end = start + 1; end < wordGroups.length; end++) {
			const nextGroup = wordGroups[end]!
			if (nextGroup.fstToken === "") continue

			const next = fst.walkFrom(current, nextGroup.fstToken)
			if (!next) break

			if (next.accepted) {
				const matchedGroups = wordGroups.slice(start, end + 1).filter((g) => g.fstToken !== "")
				applyBias(matrix, labelToCol, fst.accepting(next.stateId), matchedGroups, biasScale, maxBias, suppressionScale)
			}

			current = next
		}
	}

	return matrix
}

/**
 * Group SentencePiece pieces into whitespace-delimited words. Each word's literal text is
 * reconstructed by concatenating pieces (minus leading ▁), then normalized through the same
 * pipeline the FST builder uses.
 */
function groupPiecesIntoWords(pieces: ReadonlyArray<{ piece: string }>): WordGroup[] {
	const groups: WordGroup[] = []
	let current: WordGroup | null = null

	for (let i = 0; i < pieces.length; i++) {
		const p = pieces[i]!
		const hasAlnum = /[a-zA-Z0-9]/.test(p.piece)

		if (p.piece.startsWith(SPACE_SENTINEL) || i === 0 || !hasAlnum) {
			if (current) groups.push(current)
			if (!hasAlnum) {
				groups.push({ fstToken: "", pieceIndices: [i] })
				current = null
				continue
			}
			const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece
			current = { fstToken: literal, pieceIndices: [i] }
		} else {
			if (current) {
				current.pieceIndices.push(i)
				current.fstToken += p.piece
			}
		}
	}
	if (current) groups.push(current)

	for (const g of groups) {
		if (g.fstToken !== "") {
			g.fstToken = normalizeFstToken(g.fstToken)
		}
	}

	return groups
}

function normalizeFstToken(s: string): string {
	const cleaned = s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
	return cleaned.length > 0 ? cleaned : ""
}

function applyBias(
	matrix: number[][],
	labelToCol: Map<string, number>,
	entries: ReadonlyArray<FstPlaceEntryLike>,
	groups: WordGroup[],
	biasScale: number,
	maxBias: number,
	suppressionScale: number
): void {
	const seenTags = new Map<string, number>()

	for (const entry of entries) {
		const bioTag = PLACETYPE_TO_BIO.get(entry.placetype)
		if (!bioTag) continue
		const popBias = Math.min(biasScale * Math.log2(1 + entry.population / 1000), maxBias)
		const existing = seenTags.get(bioTag) ?? 0
		if (popBias > existing) seenTags.set(bioTag, popBias)
	}

	if (seenTags.size === 0) return

	const allPieceIndices: number[] = []
	for (const group of groups) {
		for (const pi of group.pieceIndices) allPieceIndices.push(pi)
	}

	for (const [bioTag, bias] of seenTags) {
		const bCol = labelToCol.get(`B-${bioTag}`)
		const iCol = labelToCol.get(`I-${bioTag}`)
		if (bCol === undefined) continue

		for (let k = 0; k < allPieceIndices.length; k++) {
			const pi = allPieceIndices[k]!
			const col = k === 0 ? bCol : iCol ?? bCol
			matrix[pi]![col] = Math.max(matrix[pi]![col]!, bias)
		}
	}

	if (suppressionScale > 0) {
		for (const pi of allPieceIndices) {
			for (const label of SUPPRESS_WHEN_PLACE) {
				const col = labelToCol.get(label)
				if (col !== undefined) {
					matrix[pi]![col] = Math.min(matrix[pi]![col]!, -suppressionScale)
				}
			}
		}
	}
}
