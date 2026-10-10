/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Venue-head emission bias. A venue head is a word that marks the phrase around it as a venue
 *   name: `Gallery` ends `Manchester Art Gallery`, `Musée` starts `Musée d'Orsay`, and the suffix
 *   `館` ends `国立西洋美術館`. The lexicon reports a bias for a word in one of three positions. A
 *   last-word or suffix head biases itself and the words before it toward `venue`. A first-word
 *   head biases itself and the words after it.
 *
 *   A first-word or last-word head is read only when the word has a neighbor in the same segment,
 *   so a single-word input such as `Rijksmuseum` receives a bias only through its suffix entry. A
 *   lone word is as often a locality as a venue, and the table's position rates were measured on
 *   names of two or more words.
 *
 *   The extension stays inside one comma-separated segment and stops at an identifier word: one that
 *   contains a digit, or one of a single letter. A house number or postcode is never part of the venue
 *   name it sits beside, and the `B` of `Concourse B` or the `C` of `Terminal C` belongs to the designator
 *   before it. Each word further from the head receives the head's bias multiplied by `extensionDecay`
 *   once more.
 *   The prior composes with the admin FST and the street-morphology prior through
 *   `addEmissionMatrix`; where the admin FST also claims a word, the decoder weighs both biases.
 */

import { groupPiecesIntoWords, type WordGroup } from "#fst-prior"
import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"

/**
 * Venue-head lookups for one locale.
 * Each method returns a bias in natural-log units or `null`.
 */
export interface VenueHeadLexiconLike {
	/**
	 * The bias of `word` as the first word of a venue name.
	 */
	first(word: string): number | null
	/**
	 * The bias of `word` as the last word of a venue name.
	 */
	last(word: string): number | null
	/**
	 * The bias of the longest suffix of `word`, shorter than `word`, that marks a venue name.
	 */
	suffix(word: string): number | null
}

/**
 * Overrides for {@linkcode buildVenueHeadEmissionPriors}.
 */
export interface VenueHeadPriorOpts {
	/**
	 * Multiplier on the lexicon's bias.
	 *
	 * @defaultValue `1`
	 */
	biasScale?: number
	/**
	 * Maximum bias, in logits, on any one cell.
	 *
	 * The table's biases are log rate ratios and seldom exceed 6.
	 * The cap bounds a scaled bias.
	 *
	 * @defaultValue `6`
	 */
	maxBias?: number
	/**
	 * The most words the venue span extends from its head.
	 *
	 * @defaultValue `3`
	 */
	extensionWords?: number
	/**
	 * Factor applied to the bias once for each word between a word and its head.
	 *
	 * The shipped model's venue logits trail the winning label by a near-constant margin
	 * across a landmark name's pieces, so the default extends the head's bias undiminished.
	 *
	 * @defaultValue `1`
	 */
	extensionDecay?: number
	/**
	 * Whether a word is a street-type affix, in `normalizeFSTToken` form.
	 *
	 * A head followed by one is a street name (`Museum Street`) and gets no bias,
	 * and an extension stops at one.
	 */
	isStreetAffix?: (word: string) => boolean
}

const SEGMENT_BREAK_RE = /[,;|\n]/u
const DIGIT_RE = /\p{N}/u

interface Word {
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

function wordsWithSegments(groups: readonly WordGroup[], pieces: ReadonlyArray<{ piece: string }>): Word[] {
	const words: Word[] = []
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
 * Builds a `[seqLen][numLabels]` bias matrix toward `B-venue` and `I-venue` from venue-head lookups.
 * A vocabulary without `B-venue` returns the zero matrix.
 */
export function buildVenueHeadEmissionPriors(
	lexicon: VenueHeadLexiconLike,
	pieces: ReadonlyArray<{ piece: string }>,
	labels: ReadonlyArray<string>,
	opts: VenueHeadPriorOpts = {}
): number[][] {
	const matrix = emptyPriorMatrix(pieces.length, labels.length)
	const columns = labelColumnIndex(labels)
	const bVenue = columns.get("B-venue")
	const iVenue = columns.get("I-venue") ?? bVenue

	if (bVenue === undefined || iVenue === undefined) return matrix

	const biasScale = opts.biasScale ?? 1
	const maxBias = opts.maxBias ?? 6
	const extensionWords = opts.extensionWords ?? 3
	const extensionDecay = opts.extensionDecay ?? 1
	const isStreetAffix = opts.isStreetAffix ?? (() => false)
	const words = wordsWithSegments(groupPiecesIntoWords(pieces), pieces)

	// Every piece of the span takes the bias on both venue columns.
	// A piece between two words, such as a bare `▁`, belongs to no word and keeps `O`.
	// The next word can then open a new venue span only if its `B-venue` cell holds the bias too.
	const mark = (word: Word, bias: number): void => {
		for (const pieceIndex of word.group.pieceIndices) {
			const row = matrix[pieceIndex]!
			row[bVenue] = Math.max(row[bVenue]!, bias)
			row[iVenue] = Math.max(row[iVenue]!, bias)
		}
	}

	const extend = (head: number, direction: -1 | 1, bias: number): void => {
		mark(words[head]!, bias)

		for (let k = 1; k <= extensionWords; k++) {
			const next = words[head + direction * k]

			if (!next || next.segment !== words[head]!.segment || next.isIdentifier || isStreetAffix(next.group.fstToken)) {
				break
			}

			mark(next, bias * extensionDecay ** k)
		}
	}

	for (let index = 0; index < words.length; index++) {
		const word = words[index]!

		if (word.isIdentifier) continue
		const token = word.group.fstToken
		const sameSegment = (other: Word | undefined): boolean => other?.segment === word.segment && !other.isIdentifier
		const following = words[index + 1]

		// A head followed by a street type is the street's name, as in `Museum Street`.
		if (sameSegment(following) && isStreetAffix(following!.group.fstToken)) continue
		const scaled = (bias: number | null): number | null => (bias === null ? null : Math.min(maxBias, bias * biasScale))

		const last = sameSegment(words[index - 1]) ? scaled(lexicon.last(token)) : null
		const suffix = scaled(lexicon.suffix(token))
		const backward = Math.max(last ?? 0, suffix ?? 0)

		if (backward > 0) {
			extend(index, -1, backward)
		}

		const first = sameSegment(words[index + 1]) ? scaled(lexicon.first(token)) : null

		if (first !== null && first > 0) {
			extend(index, 1, first)
		}
	}

	return matrix
}
