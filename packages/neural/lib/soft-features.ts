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
import type { Toggle } from "#classifier/options"
import { buildCountryFeatures, type CountryLexicon } from "#country-inference"
import { buildGazetteerFeatures, suppressGazetteerNearPostcode, type GazetteerLexicon } from "#gazetteer-inference"
import type { TokenizedPiece } from "#tokenizer"

/**
 * One soft-feature channel: a feature row and a confidence value per piece.
 */
export interface SoftFeatureChannel {
	features: number[][]
	confidence: number[]
}

/**
 * The soft-feature channels fed to the runner.
 * Each channel is present only when its source is configured.
 */
export interface SoftFeatures {
	/**
	 * The postcode-anchor channel.
	 */
	anchor: SoftFeatureChannel | null

	/**
	 * The gazetteer channel, already zeroed next to postcode-anchor hits when suppression is enabled.
	 */
	gazetteer: SoftFeatureChannel | null

	/**
	 * The country channel.
	 *
	 * Near-postcode suppression never applies to it, so it still marks the country in `12345 USA`.
	 */
	country: SoftFeatureChannel | null

	/**
	 * The street-type evidence channel.
	 */
	streetType: SoftFeatureChannel | null

	/**
	 * The locality-surface evidence channel.
	 *
	 * It is built only when the street-type lexicon is absent or matched at least one piece.
	 */
	localitySurface: SoftFeatureChannel | null
}

/**
 * The lexicons, anchor lookup and settings that {@link buildSoftFeatures} uses.
 *
 * A missing source skips its channel.
 */
export interface SoftFeatureSources {
	postcodeAnchorLookup?: AnchorLookup

	/**
	 * The substrings the anchor channel looks up.
	 * The default is `alnum-run`.
	 *
	 * It must match the model card's `requires.anchor.span_mode`.
	 */
	postcodeAnchorSpanMode?: AnchorSpanMode

	gazetteerLexicon?: GazetteerLexicon

	countryLexicon?: CountryLexicon

	/**
	 * Whether to zero the gazetteer channel on pieces next to a postcode-anchor hit.
	 *
	 * It needs both the gazetteer lexicon and the anchor lookup.
	 * Turn it on only for a model trained with the same suppression.
	 */
	suppressGazetteerNearPostcode: Toggle

	/**
	 * The street-type evidence lexicon uses the gazetteer lexicon schema.
	 */
	streetTypeLexicon?: GazetteerLexicon

	localitySurfaceLexicon?: GazetteerLexicon
}

/**
 * Builds the soft-feature channels for `text` and its `pieces` from the configured sources.
 *
 * The function is pure, so the classifier's decode path and diagnostic tools produce identical channels.
 */
export function buildSoftFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	sources: SoftFeatureSources
): SoftFeatures {
	warnShapedKeyerObligationOnce(sources.postcodeAnchorLookup ?? null, sources.postcodeAnchorSpanMode ?? null, null)

	const anchor = sources.postcodeAnchorLookup
		? buildAnchorFeatures(text, pieces, sources.postcodeAnchorLookup, {
				spanMode: sources.postcodeAnchorSpanMode ?? "alnum-run",
			})
		: undefined

	const gazetteer = sources.gazetteerLexicon
		? buildGazetteerFeatures(text, pieces, sources.gazetteerLexicon)
		: undefined

	const gazFed =
		gazetteer && anchor && sources.suppressGazetteerNearPostcode === "on"
			? suppressGazetteerNearPostcode(gazetteer, anchor.confidence)
			: gazetteer

	const country = sources.countryLexicon ? buildCountryFeatures(text, pieces, sources.countryLexicon) : undefined

	const streetType = sources.streetTypeLexicon
		? buildGazetteerFeatures(text, pieces, sources.streetTypeLexicon)
		: undefined

	const streetContext = streetType !== undefined && streetType.confidence.some((c) => c > 0)

	const localitySurface =
		sources.localitySurfaceLexicon && (streetContext || !sources.streetTypeLexicon)
			? buildGazetteerFeatures(text, pieces, sources.localitySurfaceLexicon)
			: undefined

	return {
		anchor: anchor ?? null,
		gazetteer: gazFed ?? null,
		country: country ?? null,
		streetType: streetType ?? null,
		localitySurface: localitySurface ?? null,
	}
}
