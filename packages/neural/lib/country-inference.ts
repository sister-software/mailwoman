/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Inference-side country-lexicon features, the third atlas soft-feed channel. Country is a closed,
 *   enumerable class of about 250 surfaces that the learned grammar mislabels in the WOF-admin and
 *   resolver hierarchy case, where "United States of America, Wyoming, <locality>" reads as a leading
 *   street. This channel injects a per-piece multi-hot clue that the piece is part of a recognized
 *   country surface phrase. The clue informs and the model decides.
 *
 *   The matcher reuses the gazetteer's phrase-scan (`gazetteerCharPaint`), so the two channels cannot
 *   drift on how a phrase is matched. Only the vocabulary (`country-surface-lexicon-v1.json`, built
 *   by `packages/mailwoman/lib/dev-tools/codex/country/surface-lexicon.ts`) and the emitted 2-dim
 *   feature differ.
 *
 *   The emitted per-piece feature is `[country_surface, country_ambiguous]`. `country_surface` marks
 *   a piece inside a recognized country surface phrase. `country_ambiguous` marks a homograph that is
 *   also a US region, such as "Georgia", or a curated common-word name such as "America". The model
 *   learns to trust the unambiguous long and code forms strongly and the ambiguous forms weakly,
 *   which keeps recall on a phrase such as "Republic of Georgia".
 *
 *   The gazetteer's own `country` slot already carries these surfaces and the shipped model already
 *   consumes them, yet the WOF-admin case still fails. That slot shares one projection with region,
 *   po_box, cedex and homograph, and it is zeroed next to a postcode by
 *   `suppressGazetteerNearPostcode`, which is exactly where "…12345 USA" sits. A separate channel
 *   gives country its own projection and confidence weight, so that suppression cannot reach it.
 */

import {
	gazetteerCharPaint,
	parseGazetteerLexicon,
	projectCharBitsToPieces,
	type GazetteerLexicon,
} from "#gazetteer-inference"
import type { TokenizedPiece } from "#tokenizer"

/**
 * The country feature width, which must match the lexicon JSON's `feature_dim` and the trained
 * model's `country_feature_dim`.
 */
export const COUNTRY_FEATURE_DIM = 2

/**
 * Lexicon bit for "this surface is a recognized country surface".
 */
export const COUNTRY_SURFACE_BIT = 1
/**
 * Lexicon bit for "this surface is ambiguous" (homograph with a US region, or a common-word name).
 */
export const COUNTRY_AMBIGUOUS_BIT = 2

/**
 * The loaded country lexicon, structurally identical to a {@linkcode GazetteerLexicon} and reused so
 * the two channels share one matcher.
 */
export type CountryLexicon = GazetteerLexicon

/**
 * Parse the country lexicon JSON, which the caller has already run through `JSON.parse` so this
 * module stays browser-safe.
 */
export function parseCountryLexicon(raw: {
	feature_dim: number
	slots: string[]
	bits: Record<string, number>
	max_ngram: number
	entries: Record<string, number>
	code_entries: Record<string, number>
}): CountryLexicon {
	return parseGazetteerLexicon(raw)
}

/**
 * Per-piece country features and confidence for `text`, projected onto its pieces by the same
 * char-to-piece rule the labels use, so the clue lands on the country phrase's sub-tokens.
 */
export function buildCountryFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lexicon: CountryLexicon
): { features: number[][]; confidence: number[] } {
	const pieceBits = projectCharBitsToPieces(text, pieces, gazetteerCharPaint(text, lexicon))
	const features: number[][] = []
	const confidence: number[] = []

	for (const bits of pieceBits) {
		const surface = bits & COUNTRY_SURFACE_BIT ? 1 : 0
		const ambiguous = bits & COUNTRY_AMBIGUOUS_BIT ? 1 : 0
		features.push([surface, ambiguous])
		confidence.push(surface ? 1 : 0)
	}

	return { features, confidence }
}
