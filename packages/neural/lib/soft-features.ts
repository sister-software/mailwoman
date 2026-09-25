/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type AnchorLookup,
	type AnchorSpanMode,
	buildAnchorFeatures,
	warnShapedKeyerObligationOnce,
} from "#anchor-inference"
import { buildCountryFeatures, type CountryLexicon } from "#country-inference"
import { buildGazetteerFeatures, suppressGazetteerNearPostcode, type GazetteerLexicon } from "#gazetteer-inference"
import type { TokenizedPiece } from "#tokenizer"

/**
 * A built soft-feature channel: per-piece feature rows + per-piece confidence.
 */
export interface SoftFeatureChannel {
	features: number[][]
	confidence: number[]
}

/**
 * Holds the soft-feature channels fed to the runner, each present only when its source is configured.
 */
export interface SoftFeatures {
	/**
	 * The postcode-anchor channel, present when a `postcodeAnchorLookup` was supplied.
	 */
	anchor?: SoftFeatureChannel

	/**
	 * The gazetteer-anchor channel, already zeroed next to postcode-anchor hits when suppression is enabled.
	 */
	gazetteer?: SoftFeatureChannel

	/**
	 * The country-lexicon channel, present when a `countryLexicon` was supplied.
	 *
	 * Near-postcode suppression never applies to it, so it still fires on a trailing `12345 USA`.
	 */
	country?: SoftFeatureChannel

	/**
	 * The street-type evidence channel, present when a `streetTypeLexicon` was supplied.
	 */
	streetType?: SoftFeatureChannel

	/**
	 * The locality-surface evidence channel, present when its lexicon was supplied
	 * and the street-type channel is absent or matched something.
	 */
	localitySurface?: SoftFeatureChannel
}

/**
 * Supplies the lexicons, anchor lookup and settings that {@link buildSoftFeatures} uses,
 * mirroring the classifier's config fields.
 */
export interface SoftFeatureSources {
	/**
	 * The postcode-to-anchor lookup; omit it to skip the anchor channel.
	 */
	postcodeAnchorLookup?: AnchorLookup

	/**
	 * Which substrings the anchor channel looks up, defaulting to `alnum-run`.
	 *
	 * It must match the model card's `requires.anchor.span_mode`, because `shaped`
	 * suits only a model trained against letter-containing keys.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode

	/**
	 * The gazetteer-anchor lexicon; omit it to skip the gazetteer channel.
	 */
	gazetteerLexicon?: GazetteerLexicon

	/**
	 * The country-surface lexicon; omit it to skip the country channel.
	 */
	countryLexicon?: CountryLexicon

	/**
	 * Whether to zero the gazetteer clue on pieces adjacent to a postcode-anchor hit,
	 * which needs both the lexicon and the anchor lookup.
	 *
	 * Enable it only for a model trained with the same suppression.
	 */
	suppressGazetteerNearPostcode?: boolean

	/**
	 * The street-type evidence lexicon, in the gazetteer lexicon schema; omit it to skip the channel.
	 */
	streetTypeLexicon?: GazetteerLexicon

	/**
	 * The locality-surface evidence lexicon; omit it to skip the channel.
	 */
	localitySurfaceLexicon?: GazetteerLexicon
}

/**
 * Builds the soft-feature channels for `text` and its `pieces` from whichever sources are configured.
 *
 * The gazetteer clue is zeroed next to postcode-anchor hits when
 * `suppressGazetteerNearPostcode` is set, and the locality-surface channel is built only
 * when the street-type lexicon is absent or matched something.
 */
export function buildSoftFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	sources: SoftFeatureSources
): SoftFeatures {
	warnShapedKeyerObligationOnce(sources.postcodeAnchorLookup, sources.postcodeAnchorSpanMode, undefined)

	const anchor = sources.postcodeAnchorLookup
		? buildAnchorFeatures(text, pieces, sources.postcodeAnchorLookup, {
				spanMode: sources.postcodeAnchorSpanMode ?? "alnum-run",
			})
		: undefined

	const gazetteer = sources.gazetteerLexicon
		? buildGazetteerFeatures(text, pieces, sources.gazetteerLexicon)
		: undefined

	const gazFed =
		gazetteer && anchor && sources.suppressGazetteerNearPostcode
			? suppressGazetteerNearPostcode(gazetteer, anchor.confidence)
			: gazetteer

	const country = sources.countryLexicon ? buildCountryFeatures(text, pieces, sources.countryLexicon) : undefined

	const streetType = sources.streetTypeLexicon
		? buildGazetteerFeatures(text, pieces, sources.streetTypeLexicon)
		: undefined

	const streetContext = streetType !== undefined && streetType.confidence.some((c) => c > 0)

	const localitySurface =
		sources.localitySurfaceLexicon && (streetContext || sources.streetTypeLexicon === undefined)
			? buildGazetteerFeatures(text, pieces, sources.localitySurfaceLexicon)
			: undefined

	return {
		...(anchor ? { anchor } : {}),
		...(gazFed ? { gazetteer: gazFed } : {}),
		...(country ? { country } : {}),
		...(streetType ? { streetType } : {}),
		...(localitySurface ? { localitySurface } : {}),
	}
}
