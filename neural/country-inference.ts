/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Inference-side country-lexicon features (#1104) — the third atlas soft-feed channel, sibling of
 *   the postcode anchor (`anchor-inference.ts`, #239/#240) and the gazetteer anchor
 *   (`gazetteer-inference.ts`, #464). Country is a CLOSED, ENUMERABLE class (~250 surfaces) the
 *   learned GRAMMAR mislabels in the WOF-admin / resolver hierarchy case ("United States of America,
 *   Wyoming, <locality>" reads as a leading STREET). This channel injects the atlas prior the tagger
 *   lacks: a per-piece multi-hot clue that the piece is part of a recognized country surface phrase.
 *   The clue INFORMS, the model decides (model-first) — the direct analogue of Pelias's
 *   position-independent `WhosOnFirstClassifier` dictionary lookup, rendered as an additive feature.
 *
 *   The matcher DELIBERATELY REUSES the gazetteer's phrase-scan (`gazetteerCharPaint`) — one tested
 *   longest-first n-gram algorithm (case-insensitive `entries` + uppercase-exact `code_entries`,
 *   char→piece projection by the first non-whitespace char), two vocabularies. Only the vocabulary
 *   (`country-surface-lexicon-v1.json`, built by `codex/tools/build-country-surface-lexicon.ts`) and
 *   the emitted 2-dim feature differ. This is the same "the JSON is the single source both consumers
 *   load, so the two implementations cannot drift" discipline as the gazetteer; `country_lexicon.py`
 *   is the Python training-side mirror and `country-inference.test.ts` pins the two together.
 *
 *   The emitted per-piece feature is `[country_surface, country_ambiguous]`:
 *
 *   - `country_surface` (bit 1) — the piece is inside a recognized country surface phrase.
 *   - `country_ambiguous` (bit 2) — the SURFACE is a homograph (also a US region, e.g. "Georgia",
 *     "CA") or a curated common-word name ("America", "England"). A SOFT false-positive guard: the
 *     model learns to trust `surface & !ambiguous` (unambiguous long/code forms) strongly and
 *     `surface & ambiguous` weakly, using context — the model-first analogue of Pelias's hard
 *     blacklist, without dropping the surface (recall on "Republic of Georgia" is preserved).
 *
 *   WHY A DEDICATED CHANNEL rather than the gazetteer's existing `country` slot: the gazetteer slot
 *   already carries these surfaces AND the shipped model already consumes them, yet the WOF-admin
 *   case still fails (#1104). The country bit is one of a 5-hot vector sharing ONE projection with
 *   region/po_box/cedex/homograph, and it is ZEROED adjacent to a postcode by
 *   `suppressGazetteerNearPostcode` (exactly where "…12345 USA" sits). A separate channel gives
 *   country its own projection + confidence weight and is immune to that suppression. See
 *   docs/superpowers/plans/2026-07-14-country-lexicon-channel.md.
 */

import { gazetteerCharPaint, parseGazetteerLexicon, type GazetteerLexicon } from "./gazetteer-inference.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

/**
 * The country feature width. The emitted per-piece row is `[country_surface, country_ambiguous]`. Used for the ONNX
 * zero-fallback when a country-trained model is run with no lexicon supplied. MUST match the lexicon JSON's
 * `feature_dim` and the trained model's `country_feature_dim`.
 */
export const COUNTRY_FEATURE_DIM = 2

/** Lexicon bit for "this surface is a recognized country surface". */
export const COUNTRY_SURFACE_BIT = 1
/** Lexicon bit for "this surface is ambiguous" (homograph with a US region, or a common-word name). */
export const COUNTRY_AMBIGUOUS_BIT = 2

/**
 * The loaded country lexicon. Structurally identical to a {@linkcode GazetteerLexicon} (the same n-gram phrase-scan
 * shape) — the type is reused deliberately so the two channels share ONE matcher. The `bits`/`slots` describe the
 * lexicon's internal bit layout (`country_surface` / `country_ambiguous`), NOT a multi-hot emitted vector.
 */
export type CountryLexicon = GazetteerLexicon

/** Parse the country lexicon JSON (already `JSON.parse`d — keeps this module browser-safe; the caller reads). */
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
 * Per-piece country features + confidence for `text`, projected onto its SP `pieces` by the SAME char→piece rule the
 * labels use (a piece takes the bits of the first non-whitespace char it covers) — so the clue lands on exactly the
 * country phrase's sub-tokens. Returns `(pieces × COUNTRY_FEATURE_DIM)` features (`[country_surface,
 * country_ambiguous]`) + `(pieces,)` confidence (1.0 wherever a country surface fires).
 *
 * REUSES `gazetteerCharPaint` — the country lexicon is the same phrase-scan structure, so the matcher is shared and the
 * two channels cannot drift on how a phrase is matched.
 */
export function buildCountryFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lexicon: CountryLexicon
): { features: number[][]; confidence: number[] } {
	const charBits = gazetteerCharPaint(text, lexicon)
	const features: number[][] = []
	const confidence: number[] = []

	for (const p of pieces) {
		let bits = 0

		for (let c = p.start; c < p.end; c++) {
			if (c < text.length && !/\s/.test(text[c]!)) {
				bits = charBits[c]!
				break
			}
		}
		const surface = bits & COUNTRY_SURFACE_BIT ? 1 : 0
		const ambiguous = bits & COUNTRY_AMBIGUOUS_BIT ? 1 : 0
		features.push([surface, ambiguous])
		confidence.push(surface ? 1.0 : 0)
	}

	return { features, confidence }
}
