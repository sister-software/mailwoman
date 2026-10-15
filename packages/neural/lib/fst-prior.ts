/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AncestrieMatch } from "@mailwoman/ancestrie"

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
 * A place stored at an accepting FST state.
 */
export interface FSTPlaceEntryLike {
	wofID: number
	placetype: string

	/**
	 * The place's gazetteer name.
	 *
	 * The anchor-region boost compares it with the written surface, so an alias such
	 * as `Washington` for the District of Columbia takes no boost.
	 */
	name?: string

	/**
	 * The WOF ids of the place's ancestors.
	 *
	 * The anchor-region boost reads it to tell whether a locality of the written
	 * name lies inside the anchored region.
	 */
	parentChain?: readonly number[]

	/**
	 * The population-based referential likelihood in [0, 1], which scales the positive emission bias.
	 *
	 * The type omits the entries' `encyclopedic` score so the bias cannot use article
	 * fame as the likelihood that the user means this place.
	 */
	referential: number
}

/**
 * The structural FST interface that the prior walks.
 *
 * It keeps this package independent of any FST implementation.
 */
export interface FSTMatcherLike {
	walk(tokens: string[]): AncestrieMatch | null
	walkFrom(prev: AncestrieMatch, token: string): AncestrieMatch | null
	accepting(stateID: number): FSTPlaceEntryLike[]
}

/**
 * Maps each FST placetype that biases the decoder to its BIO tag.
 *
 * Other placetypes, such as `county`, add no bias.
 * `localadmin` and `neighbourhood` map to `locality` so that names such as "Biggin Hill"
 * still get locality bias, except on a street-shaped surface ({@link isStreetShapedSurface}).
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
 * Reports whether FST-normalized tokens end in a strong street generic,
 * optionally followed by one directional.
 *
 * The generics are `street`, `road`, `avenue`, `boulevard` and `square`.
 * Weaker generics such as `hill` are excluded so that neighborhoods such as
 * "Biggin Hill" keep their locality bias.
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
 * An FST entry reduced to the fields that {@link collapseFSTBias} reads.
 */
export interface FSTEntryLike {
	placetype: string

	/**
	 * The entry's referential score.
	 * Callers map it from source fields with different names.
	 */
	importance: number
}

/**
 * Collapses accepting FST entries to the maximum importance per BIO tag,
 * with the same street-shape exclusion as the decoder.
 *
 * An empty map means the surface was accepted but has no BIO-mapped placetype.
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
 * A whitespace-delimited word rebuilt from SentencePiece pieces.
 *
 * An empty `fstToken` marks a placeholder that holds only spacing or punctuation.
 */
export interface WordGroup {
	fstToken: string
	pieceIndices: number[]
}

/**
 * One accepting contiguous FST path, reported without deduplication or ranking.
 *
 * `endPiece` and `endWord` are exclusive.
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
 * Selects which biases a short FST match scales down.
 *
 * `both` scales the positive place bias and the street suppression.
 * `suppression` scales only the suppression.
 * `off` scales neither.
 */
export type ImportanceLengthScaleMode = "off" | "suppression" | "both"

/**
 * Configures the street-context check.
 *
 * It scales the positive FST bias when a match is next to a street-type word or follows a house number.
 *
 * The street-morphology FST's `street_affix` entries also cover prefix locales,
 * as in French "Rue de Rivoli".
 */
export interface StreetContextRequirementOpts {
	/**
	 * The street-morphology FST matcher.
	 */
	fst: FSTMatcherLike

	/**
	 * The multiplier on the positive bias when the check fires.
	 *
	 * @defaultValue `0.25`
	 */
	positiveScale?: number
}

/**
 * Tunes the bias magnitudes, length scaling and street-context check of {@link buildFSTEmissionPriors}.
 */
export interface FSTPriorOpts {
	biasScale?: number

	/**
	 * The maximum bias magnitude in logits.
	 *
	 * The cap keeps a high-population place from overriding the model.
	 *
	 * @defaultValue `3`
	 */
	maxBias?: number
	suppressionScale?: number

	/**
	 * How match length scales the bias.
	 *
	 * @defaultValue `suppression`
	 */
	importanceLengthScaleMode?: ImportanceLengthScaleMode

	/**
	 * The street-context check.
	 * The scorer runs it only when this is set.
	 */
	streetContext?: StreetContextRequirementOpts

	/**
	 * The WOF ids of the regions the input's anchored postcodes assert.
	 *
	 * A region entry in this set whose gazetteer name is the written surface takes
	 * the full `maxBias`, outside the referential and the street-context scale,
	 * because the postcode is positive evidence that the name is that region.
	 * At that span the street labels are suppressed at full scale, and the locality
	 * labels are suppressed by `maxBias` unless a locality of the written name with a
	 * referential lies inside the region, as `New York` does in New York.
	 */
	anchorRegionIDs?: ReadonlySet<number>

	/**
	 * Receives the WOF id of each anchored region the matrix raised, when the caller passes a set.
	 */
	anchorRegionHits?: Set<number>
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

	const tuning: BiasTuning = {
		biasScale,
		maxBias,
		suppressionScale,
		seenWOFIDs,
		lengthMode,
		anchorRegionIDs: opts.anchorRegionIDs ?? null,
		anchorRegionHits: opts.anchorRegionHits ?? null,
	}

	const matrix = emptyPriorMatrix(T, L)
	const labelToCol = labelColumnIndex(labels)

	const wordGroups = groupPiecesIntoWords(pieces)

	if (!wordGroups.length) return matrix

	const streetContext = opts.streetContext ?? null

	const streetTypeFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => g.fstToken !== "" && isStreetAffix(streetContext.fst, g.fstToken))
		: null

	const houseNumberFlags: boolean[] | null = streetContext
		? wordGroups.map((g) => HOUSE_NUMBER_RE.test(g.fstToken))
		: null

	const groupSegments: number[] | null = streetContext ? segmentIndexes(wordGroups, pieces) : null

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
				streetContextScale(wordGroups, start, start, streetContext, streetTypeFlags, houseNumberFlags, groupSegments)
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
					streetContextScale(wordGroups, start, end, streetContext, streetTypeFlags, houseNumberFlags, groupSegments)
				)
			}

			current = next
		}
	}

	return matrix
}

/**
 * Groups SentencePiece pieces into FST-normalized words, splitting at the `▁` space sentinel.
 *
 * An alphanumeric piece without `▁` opens a new word when none is open,
 * because some short words lack a merged `▁word` piece.
 * Punctuation-only pieces become empty placeholder groups so that separated words never merge.
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
 * Normalizes a word to FST-index form with NFKC, lowercasing and removal of Unicode punctuation and symbols.
 *
 * Diacritics and spaces are kept.
 * The FST builder must apply the same normalization.
 */
export function normalizeFSTToken(s: string): string {
	const cleaned = s
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[\p{P}\p{S}]/gu, "")

	return cleaned ?? ""
}

/**
 * Whether the street-morphology FST accepts `token`, in {@linkcode normalizeFSTToken}
 * form, as a street-type affix.
 */
export function isStreetAffix(fst: FSTMatcherLike, token: string): boolean {
	const match = fst.walk([token])

	if (!match?.accepted) return false

	return fst.accepting(match.stateID).some((e) => e.placetype === "street_affix")
}

const SEGMENT_BREAK_RE = /[,;|\n]/u
const DIGIT_RE = /\p{N}/u

/**
 * A word group with the comma-separated segment it sits in.
 */
export interface SegmentWord {
	group: WordGroup
	segment: number
	/**
	 * Whether the word is an identifier rather than a name word: it contains a digit or is a single letter.
	 */
	isIdentifier: boolean
}

function isIdentifierWord(token: string): boolean {
	return DIGIT_RE.test(token) || [...token].length === 1
}

/**
 * Assigns each non-empty word group its segment index.
 *
 * A comma, semicolon, bar or newline in a group's pieces closes the segment after that group.
 */
export function wordsWithSegments(
	groups: readonly WordGroup[],
	pieces: ReadonlyArray<{ piece: string }>
): SegmentWord[] {
	const words: SegmentWord[] = []
	let segment = 0

	for (const group of groups) {
		const text = group.pieceIndices.map((i) => pieces[i]!.piece).join("")

		if (group.fstToken !== "") {
			words.push({ group, segment, isIdentifier: isIdentifierWord(group.fstToken) })
		}

		if (SEGMENT_BREAK_RE.test(text)) {
			segment++
		}
	}

	return words
}

/**
 * Whether the segment holding the word at `index` opens, before that word,
 * with a word that contains a digit, such as a house number.
 */
export function numberOpensSegment(words: readonly SegmentWord[], index: number): boolean {
	if (index < 0 || index >= words.length) return false
	let first = index

	while (first > 0 && words[first - 1]!.segment === words[index]!.segment) {
		first--
	}

	if (first === index) return false
	const opener = words[first]!

	return opener.isIdentifier && DIGIT_RE.test(opener.group.fstToken)
}

function adjacentNonEmptyIndex(groups: WordGroup[], from: number, direction: 1 | -1): number {
	for (let i = from + direction; i >= 0 && i < groups.length; i += direction) {
		if (groups[i]!.fstToken !== "") return i
	}

	return -1
}

/**
 * Assigns each word group, punctuation groups included, its comma-separated segment index.
 *
 * A comma, semicolon, bar or newline in a group's pieces closes the segment after that group.
 */
function segmentIndexes(groups: readonly WordGroup[], pieces: ReadonlyArray<{ piece: string }>): number[] {
	let segment = 0

	return groups.map((group) => {
		const current = segment

		if (SEGMENT_BREAK_RE.test(group.pieceIndices.map((i) => pieces[i]!.piece).join(""))) {
			segment++
		}

		return current
	})
}

/**
 * The scale on a match's positive bias from the street type or house number beside it.
 *
 * A street type's adjacency stays inside the match's segment: in `05448 New St, Vermont` the
 * state follows a comma, so the street type before the comma leaves its region bias whole.
 * A house number's adjacency crosses the comma, because a convention that writes the number
 * after the street, as in `Sofia Camarena 38, Loma Blanca`, writes the colonia next, and the
 * scaled bias keeps a colonia that is also a locality elsewhere on its dependent reading.
 */
function streetContextScale(
	groups: WordGroup[],
	startIdx: number,
	endIdx: number,
	streetContext: StreetContextRequirementOpts | null,
	streetTypeFlags: boolean[] | null,
	houseNumberFlags: boolean[] | null,
	groupSegments: number[] | null
): number {
	if (!streetContext || !streetTypeFlags || !houseNumberFlags || !groupSegments) return 1

	const prev = adjacentNonEmptyIndex(groups, startIdx, -1)

	if (
		prev >= 0 &&
		(houseNumberFlags[prev] || (streetTypeFlags[prev] && groupSegments[prev] === groupSegments[startIdx]))
	) {
		return streetContext.positiveScale ?? 0.25
	}

	const next = adjacentNonEmptyIndex(groups, endIdx, 1)

	if (next >= 0 && groupSegments[next] === groupSegments[endIdx] && streetTypeFlags[next]) {
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
	anchorRegionIDs: ReadonlySet<number> | null
	anchorRegionHits: Set<number> | null
}

/**
 * Whether the matched groups spell the entry's own gazetteer name, in FST-normalized form.
 *
 * An entry without a name is never its own surface, so a matcher that carries
 * no names gives no anchor-region boost.
 */
function surfaceIsEntryName(groups: readonly WordGroup[], entry: FSTPlaceEntryLike): boolean {
	if (entry.name === undefined) return false

	return normalizeFSTToken(entry.name) === groups.map((group) => group.fstToken).join(" ")
}

function applyBias(
	matrix: number[][],
	labelToCol: Map<string, number>,
	entries: ReadonlyArray<FSTPlaceEntryLike>,
	groups: WordGroup[],
	tuning: BiasTuning,
	contextScale: number
): void {
	const { biasScale, maxBias, suppressionScale, seenWOFIDs, lengthMode, anchorRegionIDs, anchorRegionHits } = tuning
	const seenTags = new Map<string, number>()

	const streetShaped = isStreetShapedSurface(groups.map((group) => group.fstToken))

	const anchoredRegion =
		anchorRegionIDs === null
			? null
			: (entries.find(
					(entry) =>
						entry.placetype === "region" &&
						anchorRegionIDs.has(entry.wofID) &&
						!seenWOFIDs.has(entry.wofID) &&
						surfaceIsEntryName(groups, entry)
				) ?? null)

	// A locality keeps its reading only on positive evidence: its own name is the written surface,
	// the gazetteer holds a referential for it, and it lies inside the anchored region.
	// An alias row or a locality with no referential is no evidence that the user means a locality.
	const localityInsideAnchoredRegion =
		anchoredRegion !== null &&
		entries.some(
			(entry) =>
				PLACETYPE_TO_BIO.get(entry.placetype) === "locality" &&
				entry.referential > 0 &&
				surfaceIsEntryName(groups, entry) &&
				entry.parentChain?.includes(anchoredRegion.wofID)
		)

	if (anchoredRegion) {
		anchorRegionHits?.add(anchoredRegion.wofID)
	}

	const matchLen = groups.length
	const lengthScale = FST_MATCH_LENGTH_SCALE.get(matchLen) ?? FULL_FST_MATCH_SCALE
	const posScale = lengthMode === "both" ? lengthScale : 1
	const supScale = anchoredRegion || lengthMode === "off" ? 1 : lengthScale

	for (const entry of entries) {
		if (seenWOFIDs.has(entry.wofID)) continue
		seenWOFIDs.add(entry.wofID)
		const bioTag = PLACETYPE_TO_BIO.get(entry.placetype)

		if (!bioTag) continue

		if (streetShaped && MAPPED_TIER_PLACETYPES.has(entry.placetype)) continue

		const impBias =
			entry === anchoredRegion ? biasScale * maxBias : entry.referential * biasScale * maxBias * posScale * contextScale

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

	if (anchoredRegion && !localityInsideAnchoredRegion) {
		for (const pi of allPieceIndices) {
			for (const label of ["B-locality", "I-locality"]) {
				const col = labelToCol.get(label)

				if (col !== undefined) {
					matrix[pi]![col] = Math.min(matrix[pi]![col]!, -biasScale * maxBias)
				}
			}
		}
	}
}
