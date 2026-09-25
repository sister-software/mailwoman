/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"
import type { TokenLike } from "#query-shape-prior"

const FST_MATCH_LENGTH_SCALE: ReadonlyMap<number, number> = new Map([
	[1, 0.25],
	[2, 0.7],
])

const FULL_FST_MATCH_SCALE = 1

const SPACE_SENTINEL = "▁"

const BYTE_FALLBACK_RE = /^<0x[0-9A-Fa-f]{2}>$/

function hasWordContent(piece: string): boolean {
	const literal = piece.startsWith(SPACE_SENTINEL) ? piece.slice(SPACE_SENTINEL.length) : piece

	if (BYTE_FALLBACK_RE.test(literal)) return false

	return /[\p{L}\p{N}]/u.test(piece)
}

/**
 * Represents a position reached by walking tokens through a gazetteer FST,
 * where `accepted` means the walked tokens form a complete indexed name.
 */
export interface FSTMatchLike {
	stateID: number
	accepted: boolean
	depth: number
}

/**
 * Describes a place stored at an accepting FST state, whose `referential`
 * likelihood scales the positive emission bias.
 */
export interface FSTPlaceEntryLike {
	wofID: number
	placetype: string

	/**
	 * The population-anchored referential likelihood in [0, 1], the only score the decoder bias reads.
	 *
	 * The type deliberately omits the entries' `encyclopedic` score, so the bias cannot
	 * start using article fame as the probability that the user means this place.
	 */
	referential: number
}

/**
 * Declares the structural FST interface the prior walks, which keeps this package
 * independent of any concrete FST implementation.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): FSTMatchLike | null
	walkFrom(prev: FSTMatchLike, token: string): FSTMatchLike | null
	accepting(stateID: number): FSTPlaceEntryLike[]
}

/**
 * Maps each FST placetype that biases the decoder to its BIO tag; any other placetype,
 * such as `county`, never touches the emission matrix.
 *
 * `localadmin` and `neighbourhood` map to `locality` so covering surfaces like "Biggin Hill"
 * still draw locality bias, except on a street-shaped surface ({@link isStreetShapedSurface}).
 */
export const PLACETYPE_TO_BIO: ReadonlyMap<string, string> = new Map([
	["country", "country"],
	["region", "region"],
	["locality", "locality"],
	["localadmin", "locality"],
	["neighbourhood", "locality"],
	["postalcode", "postcode"],
])

const MAPPED_TIER_PLACETYPES: ReadonlySet<string> = new Set(["localadmin", "neighbourhood"])

/**
 * Reports whether FST-normalized tokens end in a hard street generic
 * (`street`, `road`, `avenue`, `boulevard`, `square`), optionally followed by one directional.
 *
 * Softer generics such as `hill` are deliberately excluded, because "Biggin
 * Hill"-style neighbourhoods must keep their locality bias.
 */
export function isStreetShapedSurface(tokens: readonly string[]): boolean {
	if (!tokens.length) return false

	let last = tokens.length - 1

	if (STREET_SHAPE_DIRECTIONALS.has(tokens[last]!)) {
		if (last === 0) return false
		last -= 1
	}

	return last > 0 && STREET_SHAPE_GENERICS.has(tokens[last]!)
}

const STREET_SHAPE_GENERICS: ReadonlySet<string> = new Set(["street", "road", "avenue", "boulevard", "square"])
const STREET_SHAPE_DIRECTIONALS: ReadonlySet<string> = new Set(["east", "west", "north", "south", "upper", "lower"])

/**
 * An FST entry as both the decoder and the probes read it.
 */
export interface FSTEntryLike {
	placetype: string

	/**
	 * The entry's referential score, under a generic name because the callers
	 * read it from differently named fields.
	 */
	importance: number
}

/**
 * Collapses accepting FST entries to the maximum importance per BIO tag, the only granularity
 * the decoder acts on, applying the same street-shape exclusion as the decoder.
 *
 * An empty map means the surface was accepted but has no BIO-mapped placetype,
 * which differs from not being accepted at all.
 */
export function collapseFSTBias(
	entries: ReadonlyArray<FSTEntryLike>,
	surfaceTokens: readonly string[]
): Map<string, number> {
	const byTag = new Map<string, number>()
	const streetShaped = isStreetShapedSurface(surfaceTokens)

	for (const entry of entries) {
		const tag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!tag) continue

		if (streetShaped && MAPPED_TIER_PLACETYPES.has(entry.placetype)) continue

		byTag.set(tag, Math.max(byTag.get(tag) ?? 0, entry.importance))
	}

	return byTag
}

/**
 * Represents a whitespace-delimited word reconstructed from SentencePiece pieces,
 * where an empty `fstToken` marks a placeholder holding only spacing or punctuation.
 */
export interface WordGroup {
	fstToken: string
	pieceIndices: number[]
}

/**
 * Describes one accepting contiguous FST path, reported for observability without
 * deduplication, ranking or bias policy; `endPiece` and `endWord` are exclusive.
 */
export interface FSTAcceptedMatch {
	startPiece: number
	endPiece: number
	startWord: number
	endWord: number
	entries: FSTPlaceEntryLike[]
}

/**
 * Enumerates every accepting contiguous FST path over the same words
 * {@link buildFSTEmissionPriors} walks, in order of start word and then end word.
 */
export function findFSTAcceptedMatches(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<{ piece: string }>
): FSTAcceptedMatch[] {
	const groups = groupPiecesIntoWords(pieces)
	const matches: FSTAcceptedMatch[] = []

	for (let startWord = 0; startWord < groups.length; startWord++) {
		const first = groups[startWord]!

		if (first.fstToken === "") continue
		const firstMatch = fst.walk([first.fstToken])

		if (!firstMatch) continue

		if (firstMatch.accepted) {
			matches.push(acceptedMatch(startWord, startWord, [first], fst.accepting(firstMatch.stateID)))
		}

		let current = firstMatch

		for (let endWord = startWord + 1; endWord < groups.length; endWord++) {
			const nextGroup = groups[endWord]!

			if (nextGroup.fstToken === "") continue
			const next = fst.walkFrom(current, nextGroup.fstToken)

			if (!next) break

			if (next.accepted) {
				const matchedGroups = groups.slice(startWord, endWord + 1).filter((group) => group.fstToken !== "")
				matches.push(acceptedMatch(startWord, endWord, matchedGroups, fst.accepting(next.stateID)))
			}

			current = next
		}
	}

	return matches
}

function acceptedMatch(
	startWord: number,
	endWord: number,
	groups: ReadonlyArray<WordGroup>,
	entries: FSTPlaceEntryLike[]
): FSTAcceptedMatch {
	const pieceIndices = groups.flatMap((group) => group.pieceIndices)

	return {
		startPiece: pieceIndices[0]!,
		endPiece: pieceIndices.at(-1)! + 1,
		startWord,
		endWord: endWord + 1,
		entries,
	}
}

const SUPPRESS_WHEN_PLACE: readonly string[] = ["B-street", "I-street", "B-house_number", "I-house_number", "B-venue"]

/**
 * Selects whether short, weak-evidence FST matches scale down both the positive place bias
 * and the street suppression (`both`), only the suppression (`suppression`), or neither (`off`).
 */
export type ImportanceLengthScaleMode = "off" | "suppression" | "both"

/**
 * Configures the check that scales the positive FST bias by `positiveScale` (default `0.25`)
 * when a match is adjacent to a street-type word or follows a house number.
 *
 * `fst` is the street-morphology FST, whose `street_affix` entries also cover
 * prefix locales such as French "Rue de Rivoli".
 */
export interface StreetContextRequirementOpts {
	/**
	 * The street-morphology FST matcher, the same instance the street-morphology prior uses.
	 */
	fst: FSTMatcherLike

	/**
	 * The multiplier on the positive importance bias when the check fires, default 0.25.
	 */
	positiveScale?: number
}

/**
 * Tunes the bias magnitudes, length scaling and street-context check of {@link buildFSTEmissionPriors}.
 */
export interface FSTPriorOpts {
	biasScale?: number

	/**
	 * The maximum bias magnitude in logits, default 3, which keeps a high-population
	 * place from overriding the model.
	 */
	maxBias?: number
	suppressionScale?: number

	/**
	 * How match length scales the importance bias, default `suppression`.
	 */
	importanceLengthScaleMode?: ImportanceLengthScaleMode

	/**
	 * The street-context check; when absent, the check does not run.
	 */
	streetContext?: StreetContextRequirementOpts
}

const HOUSE_NUMBER_RE = /^\d{1,6}[a-z]?$/

/**
 * Builds a `[seqLen][numLabels]` bias matrix that raises the mapped place labels on every
 * FST-matched span and suppresses street, house-number and venue labels there.
 *
 * Each WOF id contributes bias only at the first span that reaches it.
 */
export function buildFSTEmissionPriors(
	fst: FSTMatcherLike,
	pieces: ReadonlyArray<TokenLike & { piece: string }>,
	labels: ReadonlyArray<string>,
	opts: FSTPriorOpts = {}
): number[][] {
	const T = pieces.length
	const L = labels.length
	const biasScale = opts.biasScale ?? 1
	const seenWOFIDs = new Set<number>()
	const maxBias = opts.maxBias ?? 3
	const suppressionScale = opts.suppressionScale ?? 1.5

	const lengthMode: ImportanceLengthScaleMode = opts.importanceLengthScaleMode ?? "suppression"
	const tuning: BiasTuning = { biasScale, maxBias, suppressionScale, seenWOFIDs, lengthMode }
	const matrix = emptyPriorMatrix(T, L)
	const labelToCol = labelColumnIndex(labels)

	const wordGroups = groupPiecesIntoWords(pieces)

	if (!wordGroups.length) return matrix

	const streetContext = opts.streetContext

	const streetTypeFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => g.fstToken !== "" && isStreetAffix(streetContext.fst, g.fstToken))
		: null

	const houseNumberFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => HOUSE_NUMBER_RE.test(g.fstToken))
		: null

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
				tuning,
				streetContextScale(wordGroups, start, start, streetContext, streetTypeFlags, houseNumberFlags)
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
					tuning,
					streetContextScale(wordGroups, start, end, streetContext, streetTypeFlags, houseNumberFlags)
				)
			}

			current = next
		}
	}

	return matrix
}

/**
 * Groups SentencePiece pieces into FST-normalized whitespace words,
 * splitting only at the `▁` space sentinel.
 *
 * A non-`▁` alphanumeric piece opens a new word when none is open, because short
 * words often lack a merged `▁word` token; punctuation-only pieces become empty
 * placeholder groups so separated words never fuse.
 */
export function groupPiecesIntoWords(pieces: ReadonlyArray<{ piece: string }>): WordGroup[] {
	const groups: WordGroup[] = []
	let current: WordGroup | null = null

	for (let i = 0; i < pieces.length; i++) {
		const p = pieces[i]!
		const hasAlnum = hasWordContent(p.piece)
		const startsNewWord = p.piece.startsWith(SPACE_SENTINEL) || i === 0

		if (startsNewWord) {
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
		} else if (!hasAlnum) {
			if (current) {
				current.pieceIndices.push(i)
			} else {
				groups.push({ fstToken: "", pieceIndices: [i] })
			}
		} else if (current) {
			current.pieceIndices.push(i)
			current.fstToken += p.piece
		} else {
			current = { fstToken: p.piece, pieceIndices: [i] }
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

/**
 * Normalizes a word to FST-index form by applying NFKC, lowercasing and stripping
 * Unicode punctuation and symbols, keeping diacritics and spaces.
 *
 * The FST builder uses the same pipeline, so indexed and query surfaces always agree.
 */
export function normalizeFSTToken(s: string): string {
	const cleaned = s
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[\p{P}\p{S}]/gu, "")

	return cleaned.length ? cleaned : ""
}

function isStreetAffix(fst: FSTMatcherLike, token: string): boolean {
	const match = fst.walk([token])

	if (!match?.accepted) return false

	return fst.accepting(match.stateID).some((e) => e.placetype === "street_affix")
}

function adjacentNonEmptyIndex(groups: WordGroup[], from: number, direction: 1 | -1): number {
	for (let i = from + direction; i >= 0 && i < groups.length; i += direction) {
		if (groups[i]!.fstToken !== "") return i
	}

	return -1
}

function streetContextScale(
	groups: WordGroup[],
	startIdx: number,
	endIdx: number,
	streetContext: StreetContextRequirementOpts | undefined,
	streetTypeFlags: boolean[] | null,
	houseNumberFlags: boolean[] | null
): number {
	if (!streetContext || !streetTypeFlags || !houseNumberFlags) return 1

	const prev = adjacentNonEmptyIndex(groups, startIdx, -1)

	if (prev >= 0 && (streetTypeFlags[prev] || houseNumberFlags[prev])) {
		return streetContext.positiveScale ?? 0.25
	}

	const next = adjacentNonEmptyIndex(groups, endIdx, 1)

	if (next >= 0 && streetTypeFlags[next]) {
		return streetContext.positiveScale ?? 0.25
	}

	return 1
}

interface BiasTuning {
	biasScale: number
	maxBias: number
	suppressionScale: number
	seenWOFIDs: Set<number>
	lengthMode: ImportanceLengthScaleMode
}

function applyBias(
	matrix: number[][],
	labelToCol: Map<string, number>,
	entries: ReadonlyArray<FSTPlaceEntryLike>,
	groups: WordGroup[],
	tuning: BiasTuning,
	contextScale: number
): void {
	const { biasScale, maxBias, suppressionScale, seenWOFIDs, lengthMode } = tuning
	const seenTags = new Map<string, number>()

	const streetShaped = isStreetShapedSurface(groups.map((group) => group.fstToken))

	const matchLen = groups.length
	const lengthScale = FST_MATCH_LENGTH_SCALE.get(matchLen) ?? FULL_FST_MATCH_SCALE
	const posScale = lengthMode === "both" ? lengthScale : 1
	const supScale = lengthMode === "off" ? 1 : lengthScale

	for (const entry of entries) {
		if (seenWOFIDs.has(entry.wofID)) continue
		seenWOFIDs.add(entry.wofID)
		const bioTag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!bioTag) continue

		if (streetShaped && MAPPED_TIER_PLACETYPES.has(entry.placetype)) continue

		const impBias = entry.referential * biasScale * maxBias * posScale * contextScale
		const existing = seenTags.get(bioTag) ?? 0

		if (impBias > existing) {
			seenTags.set(bioTag, impBias)
		}
	}

	if (!seenTags.size) return

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
