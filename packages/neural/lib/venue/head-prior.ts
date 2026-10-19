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
 *   lone word is as likely a locality as a venue, and the table's position rates were measured on
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

import type { VenueHeadLexiconLike, VenueHeadPriorOpts } from "@mailwoman/core/pipeline"

import { groupPiecesIntoWords, numberOpensSegment, wordsWithSegments, type SegmentWord } from "#fst-prior"
import { emptyPriorMatrix, labelColumnIndex } from "#prior-matrix"

/**
 * The default multiplier on the lexicon's bias.
 *
 * At 1, a head of bias 3.67 such as GB `gallery` leaves the model's own `locality`
 * and `region` emissions ahead on every word of `Manchester Art Gallery`, by 0.7 to 2.7 logits.
 * At 2, the full regression board changes 6 of 1,257 rows, 2 of them improvements and none regressed.
 */
export const DEFAULT_VENUE_HEAD_BIAS_SCALE = 2

const DECORATION_SEPARATOR_RE = /[-–—]/u

/**
 * Reports whether a dash sits between two words' pieces, the separator a decorated venue
 * name such as `Mischicks Day Spa - St Andrews Lakes` writes between its parts.
 */
function followsDecorationSeparator(
	pieces: ReadonlyArray<{ piece: string }>,
	previousEnd: number,
	start: number
): boolean {
	for (let index = previousEnd + 1; index < start; index++) {
		if (DECORATION_SEPARATOR_RE.test(pieces[index]!.piece)) return true
	}

	return false
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

	if (!bVenue || !iVenue) return matrix

	const biasScale = opts.biasScale ?? DEFAULT_VENUE_HEAD_BIAS_SCALE
	const maxBias = opts.maxBias ?? 6
	const extensionWords = opts.extensionWords ?? 3
	const extensionDecay = opts.extensionDecay ?? 1
	const isStreetAffix = opts.isStreetAffix ?? (() => false)
	const isCountryName = opts.isCountryName ?? (() => false)
	const words = wordsWithSegments(groupPiecesIntoWords(pieces), pieces)

	// A segment that is a country name holds no venue head: `america` heads `Bank of America`,
	// and `United States of America` is the country.
	const segmentTexts = new Map<number, string[]>()

	for (const word of words) {
		segmentTexts.set(word.segment, [...(segmentTexts.get(word.segment) ?? []), word.group.fstToken])
	}

	const countrySegments = new Set(
		[...segmentTexts.entries()].filter(([, tokens]) => isCountryName(tokens.join(" "))).map(([segment]) => segment)
	)

	// Every piece of the span takes the bias on both venue columns.
	// A piece between two words, such as a bare `▁`, belongs to no word and keeps `O`.
	// The next word can then open a new venue span only if its `B-venue` cell holds the bias too.
	const mark = (word: SegmentWord, bias: number): void => {
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

		if (word.isIdentifier || countrySegments.has(word.segment)) continue
		const token = word.group.fstToken

		const sameSegment = (other: SegmentWord | undefined): boolean =>
			other?.segment === word.segment && !other.isIdentifier

		const following = words[index + 1]

		// A head followed by a street type is the street's name, as in `Museum Street`.
		if (sameSegment(following) && isStreetAffix(following!.group.fstToken)) continue
		const scaled = (bias: number | null): number | null => (bias === null ? null : Math.min(maxBias, bias * biasScale))

		// A head that is itself a street type closes a street name when a house number
		// opens the span, as `Plaza` does in `30 Rockefeller Plaza`.
		// The table measured `plaza` and `center` as venue heads on names without a number,
		// so its rate applies to an unnumbered name only.
		const numbered = isStreetAffix(token) && numberOpensSegment(words, index)
		const last = sameSegment(words[index - 1]) && !numbered ? scaled(lexicon.last(token)) : null
		const suffix = numbered ? null : scaled(lexicon.suffix(token))
		const backward = Math.max(last ?? 0, suffix ?? 0)

		if (backward > 0) {
			extend(index, -1, backward)
		}

		// A street type reads as a first-word head only when it opens its segment or a dash-separated
		// decoration, as `St` does in `St Mary's Church` and in `Mischicks Day Spa - St Andrews Lakes`.
		// After a street name, as in `6th St SW`, it is the street's type.
		const previous = words[index - 1]

		const opensSegment =
			!previous ||
			previous.segment !== word.segment ||
			followsDecorationSeparator(pieces, previous.group.pieceIndices.at(-1)!, word.group.pieceIndices[0]!)

		const first =
			sameSegment(words[index + 1]) && (opensSegment || !isStreetAffix(token)) ? scaled(lexicon.first(token)) : null

		if (first !== null && first > 0) {
			extend(index, 1, first)
		}
	}

	return matrix
}
