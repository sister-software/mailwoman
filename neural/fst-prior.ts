/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft-prior emission biases derived from the FST gazetteer. When the FST finds that a token
 *   sequence matches a known place name (e.g., "New York" → locality + region), this module
 *   produces additive biases that nudge the Viterbi decoder toward the matching BIO labels.
 *
 *   Composes with the QueryShape prior via addEmissionMatrix — same integration point, same additive
 *   semantics.
 *
 *   SentencePiece ↔ FST bridge: SentencePiece pieces are grouped into whitespace words (by the ▁
 *   sentinel), normalized through the same pipeline as FST edges (NFKC, lowercase, strip
 *   non-alnum), and walked through the FST as contiguous subpaths.
 *
 *   Uses structural typing for the FST input so this module has zero dependencies on
 *   `@mailwoman/resolver-wof-sqlite` — consumers pass an FSTMatcher instance, but this file only
 *   consumes the shape.
 */

import type { TokenLike } from "./query-shape-prior.ts"

const SPACE_SENTINEL = "▁"

// ---------------------------------------------------------------------------
// Structural types — compatible with @mailwoman/resolver-wof-sqlite shapes
// ---------------------------------------------------------------------------

export interface FSTMatchLike {
	stateID: number
	accepted: boolean
	depth: number
}

export interface FSTPlaceEntryLike {
	wofID: number
	placetype: string
	importance: number
}

export interface FSTMatcherLike {
	walk(tokens: string[]): FSTMatchLike | null
	walkFrom(prev: FSTMatchLike, token: string): FSTMatchLike | null
	accepting(stateID: number): FSTPlaceEntryLike[]
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

export interface WordGroup {
	fstToken: string
	pieceIndices: number[]
}

const SUPPRESS_WHEN_PLACE: readonly string[] = ["B-street", "I-street", "B-house_number", "I-house_number", "B-venue"]

/**
 * Match-length scaling mode for the importance bias (#1142). A single-token place match is weak evidence (a place name
 * that is also a surname / street head / common word); a multi-token match is reliable. `both` scales the positive
 * locality bias AND the street suppression by match length; `suppression` scales only the suppression (leaving the
 * positive bias intact — safe for the bare-fragment regime where the positive gazetteer bias earns its keep); `off`
 * disables it.
 */
export type ImportanceLengthScaleMode = "off" | "suppression" | "both"

export interface FSTPriorOpts {
	biasScale?: number
	/**
	 * Maximum bias magnitude (logits). Prevents large-population places from overriding the model. Default 3.0.
	 */
	maxBias?: number
	suppressionScale?: number
	/** See {@link ImportanceLengthScaleMode}. Default `suppression` (measured best; see the caller). */
	importanceLengthScaleMode?: ImportanceLengthScaleMode
}

/**
 * Build a `[seqLen][numLabels]` bias matrix from FST gazetteer matches.
 *
 * Walks all contiguous subpaths of the reconstructed whitespace-token sequence through the FST. For each accepting
 * state, biases the corresponding BIO labels on the matched pieces.
 */
export function buildFSTEmissionPriors(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: FSTPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1.0
	const seenWOFIDs = new Set<number>()
	const maxBias = opts.maxBias ?? 3.0
	const suppressionScale = opts.suppressionScale ?? 1.5
	// Default `suppression` (#1142, measured 2026-07-18): scaling ONLY the street-suppression term by
	// match length is a broad win (US golden +35, admin-street-homonym fragments +50, bare-locality −2),
	// and it leaves the positive locality bias untouched so the bare-fragment regime is safe. Scaling the
	// positive term too (`both`) measured strictly worse (US +26, FR −9). See docs/…/the-meaning-of-zero.
	const lengthMode: ImportanceLengthScaleMode = opts.importanceLengthScaleMode ?? "suppression"
	const matrix: number[][] = []

	for (let t = 0; t < T; t++) {
		matrix.push(new Array<number>(L).fill(0))
	}

	const labelToCol = new Map<string, number>()

	for (let k = 0; k < labels.length; k++) {
		labelToCol.set(labels[k]!, k)
	}

	const wordGroups = groupPiecesIntoWords(pieces)

	if (wordGroups.length === 0) return matrix

	for (let start = 0; start < wordGroups.length; start++) {
		const group = wordGroups[start]!

		if (group.fstToken === "") continue

		const match = fst.walk([group.fstToken])

		if (!match) continue

		if (match.accepted) {
			applyBias(
				matrix,
				labelToCol,
				fst.accepting(match.stateID),
				[group],
				biasScale,
				maxBias,
				suppressionScale,
				seenWOFIDs,
				lengthMode
			)
		}

		let current = match

		for (let end = start + 1; end < wordGroups.length; end++) {
			const nextGroup = wordGroups[end]!

			if (nextGroup.fstToken === "") continue

			const next = fst.walkFrom(current, nextGroup.fstToken)

			if (!next) break

			if (next.accepted) {
				const matchedGroups = wordGroups.slice(start, end + 1).filter((g) => g.fstToken !== "")
				applyBias(
					matrix,
					labelToCol,
					fst.accepting(next.stateID),
					matchedGroups,
					biasScale,
					maxBias,
					suppressionScale,
					seenWOFIDs,
					lengthMode
				)
			}

			current = next
		}
	}

	return matrix
}

/**
 * Group SentencePiece pieces into whitespace-delimited words. Each word's literal text is reconstructed by
 * concatenating pieces (minus leading ▁), then normalized through the same pipeline the FST builder uses.
 *
 * Exported (alongside {@linkcode normalizeFSTToken} and the {@linkcode WordGroup} type) so the street-morphology prior
 * can reuse the same piece-grouping/normalization pipeline without duplication. Internal helper signature; not part of
 * the public neural API.
 */
export function groupPiecesIntoWords(pieces: ReadonlyArray<{ piece: string }>): WordGroup[] {
	const groups: WordGroup[] = []
	let current: WordGroup | null = null

	for (let i = 0; i < pieces.length; i++) {
		const p = pieces[i]!
		const hasAlnum = /[\p{L}\p{N}]/u.test(p.piece)

		if (p.piece.startsWith(SPACE_SENTINEL) || i === 0 || !hasAlnum) {
			if (current) {
				groups.push(current)
			}

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

	if (current) {
		groups.push(current)
	}

	for (const g of groups) {
		if (g.fstToken !== "") {
			g.fstToken = normalizeFSTToken(g.fstToken)
		}
	}

	return groups
}

function normalizeFSTToken(s: string): string {
	const cleaned = s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}]/gu, "")

	return cleaned.length > 0 ? cleaned : ""
}

function applyBias(
	matrix: number[][],
	labelToCol: Map<string, number>,
	entries: ReadonlyArray<FSTPlaceEntryLike>,
	groups: WordGroup[],
	biasScale: number,
	maxBias: number,
	suppressionScale: number,
	seenWOFIDs: Set<number>,
	lengthMode: ImportanceLengthScaleMode
): void {
	const seenTags = new Map<string, number>()

	// Match-length scaling (#1142). A single-token place match ("Sweeney", "Tower", "Rome") is weak
	// evidence — surnames, street heads, and everyday words are place names *somewhere*; a multi-token
	// match ("New York", "Saint Louis") is far more reliable. Without this, real gazetteer importance
	// pulls the leading token of a bare/comma-free street into locality ("Sweeney Ranch Road" → loc
	// "Sweeney"; measured US golden −22, the no-anchor comma-free class). `suppression` scales only the
	// street-suppression term (safe for the bare-fragment regime where the positive bias earns its keep);
	// `both` also scales the positive locality bias; `off` disables. Locale-general — no word list.
	const matchLen = groups.length
	const lengthScale = matchLen >= 3 ? 1.0 : matchLen === 2 ? 0.7 : 0.25
	const posScale = lengthMode === "both" ? lengthScale : 1.0
	const supScale = lengthMode === "off" ? 1.0 : lengthScale

	for (const entry of entries) {
		if (seenWOFIDs.has(entry.wofID)) continue
		seenWOFIDs.add(entry.wofID)
		const bioTag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!bioTag) continue
		const impBias = entry.importance * biasScale * maxBias * posScale
		const existing = seenTags.get(bioTag) ?? 0

		if (impBias > existing) {
			seenTags.set(bioTag, impBias)
		}
	}

	if (seenTags.size === 0) return

	const allPieceIndices: number[] = []

	for (const group of groups) {
		for (const pi of group.pieceIndices) {
			allPieceIndices.push(pi)
		}
	}

	for (const [bioTag, bias] of seenTags) {
		const bCol = labelToCol.get(`B-${bioTag}`)
		const iCol = labelToCol.get(`I-${bioTag}`)

		if (bCol === undefined) continue

		for (let k = 0; k < allPieceIndices.length; k++) {
			const pi = allPieceIndices[k]!
			const col = k === 0 ? bCol : (iCol ?? bCol)
			matrix[pi]![col] = Math.max(matrix[pi]![col]!, bias)
		}
	}

	if (suppressionScale > 0) {
		// Scale the street/house-number suppression by the same match length — a lone place-name token
		// must not strongly suppress the street reading of the token it heads (#1142).
		const scaledSuppression = suppressionScale * supScale

		for (const pi of allPieceIndices) {
			for (const label of SUPPRESS_WHEN_PLACE) {
				const col = labelToCol.get(label)

				if (col !== undefined) {
					matrix[pi]![col] = Math.min(matrix[pi]![col]!, -scaledSuppression)
				}
			}
		}
	}
}
