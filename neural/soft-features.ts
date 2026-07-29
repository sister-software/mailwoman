/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The SOFT-FEATURE channels (#718) — the per-piece anchor + gazetteer clues the model conditions on
 *   alongside `input_ids`. This module is the single, PURE, browser-safe home for the channel
 *   choreography that used to live inline in `NeuralAddressClassifier.#decode`: build the postcode
 *   anchor, build the gazetteer clue, and (when paired with the matching train-time half) suppress
 *   the gazetteer clue adjacent to a postcode-anchor hit.
 *
 *   It is the essential contract surface for the ProductionScorer (#718): the scorer asserts which
 *   channels are fed, this function decides HOW they are fed. Keeping it a pure function means both
 *   the classifier and any harness build features identically — there is exactly one choreography.
 *
 *   No `fs`, no Node builtins: the caller hands in the already-parsed lookup/lexicon (mirrors
 *   `anchor-inference.ts` / `gazetteer-inference.ts`, which are themselves pure for the same
 *   reason).
 */

import { buildAnchorFeatures, type AnchorLookup } from "./anchor-inference.ts"
import { buildCountryFeatures, type CountryLexicon } from "./country-inference.ts"
import { buildGazetteerFeatures, suppressGazetteerNearPostcode, type GazetteerLexicon } from "./gazetteer-inference.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

/**
 * A built soft-feature channel: per-piece feature rows + per-piece confidence.
 */
export interface SoftFeatureChannel {
	features: number[][]
	confidence: number[]
}

/**
 * The soft-feature channels fed to the runner. Each is present only when its source is configured.
 */
export interface SoftFeatures {
	/**
	 * Postcode-anchor channel (#239/#240) — present iff `postcodeAnchorLookup` was supplied.
	 */
	anchor?: SoftFeatureChannel
	/**
	 * Gazetteer-anchor channel (#464) — present iff `gazetteerLexicon` was supplied. Already choreographed: when
	 * `suppressGazetteerNearPostcode` is set AND an anchor channel exists, the clue is zeroed adjacent to postcode-anchor
	 * hits before it's returned here.
	 */
	gazetteer?: SoftFeatureChannel
	/**
	 * Country-lexicon channel (#1104) — present iff `countryLexicon` was supplied. DELIBERATELY NOT subject to
	 * `suppressGazetteerNearPostcode`: unlike the gazetteer's country slot, this channel fires on a trailing "…12345 USA"
	 * (where the gazetteer clue is zeroed by the near-postcode choreography). See `country-inference.ts`.
	 */
	country?: SoftFeatureChannel
	/**
	 * Street-type evidence channel (Option-A bundle, Phase 2) — present iff `streetTypeLexicon` was supplied. Painted by
	 * the SAME generic painter as the gazetteer channel (the lexicons share one schema); no choreography — the bundle's
	 * anti-over-trust discipline is the TRAIN-side curriculum, not a decode-side transform.
	 */
	streetType?: SoftFeatureChannel
	/**
	 * Locality-surface evidence channel (Option-A bundle, Phase 2) — present iff `localitySurfaceLexicon` was supplied.
	 */
	localitySurface?: SoftFeatureChannel
}

/**
 * Sources + choreography for {@link buildSoftFeatures}. Mirrors the classifier's config fields.
 */
export interface SoftFeatureSources {
	/**
	 * Postcode→anchor lookup (#239/#240). Omit to skip the anchor channel.
	 */
	postcodeAnchorLookup?: AnchorLookup
	/**
	 * Gazetteer-anchor lexicon (#464). Omit to skip the gazetteer channel.
	 */
	gazetteerLexicon?: GazetteerLexicon
	/**
	 * Country-lexicon (#1104). Omit to skip the country channel.
	 */
	countryLexicon?: CountryLexicon
	/**
	 * Channel choreography (#464, v0.9.13 postcode fix): zero the gazetteer clue on pieces adjacent to a postcode-anchor
	 * hit. Needs BOTH a `gazetteerLexicon` and a `postcodeAnchorLookup` to take effect (the suppression is keyed off the
	 * anchor's confidence). PAIRING IS ESSENTIAL — enable this IFF the model was trained with the matching train-time
	 * choreography. See `suppressGazetteerNearPostcode` in `gazetteer-inference.ts`. Does NOT touch the country channel.
	 */
	suppressGazetteerNearPostcode?: boolean
	/**
	 * Street-type evidence lexicon (Option-A bundle). Omit to skip the channel. Same JSON schema as the gazetteer.
	 */
	streetTypeLexicon?: GazetteerLexicon
	/**
	 * Locality-surface evidence lexicon (Option-A bundle). Omit to skip the channel.
	 */
	localitySurfaceLexicon?: GazetteerLexicon
}

/**
 * Build the soft-feature channels for `text`/`pieces` from the configured sources — the EXACT choreography previously
 * inlined in `NeuralAddressClassifier.#decode`:
 *
 * 1. Anchor channel from `postcodeAnchorLookup` (no-op when unset).
 * 2. Gazetteer channel from `gazetteerLexicon` (no-op when unset).
 * 3. If both channels exist AND `suppressGazetteerNearPostcode`, zero the gazetteer clue adjacent to postcode-anchor hits.
 * 4. Country channel from `countryLexicon` (no-op when unset) — INDEPENDENT of the near-postcode choreography.
 *
 * Pure + byte-stable: the returned channels are identical to the pre-#718 inline path, so wiring this into `#decode` is
 * a behavior-preserving refactor.
 */
export function buildSoftFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	sources: SoftFeatureSources
): SoftFeatures {
	const anchor = sources.postcodeAnchorLookup
		? buildAnchorFeatures(text, pieces, sources.postcodeAnchorLookup)
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

	// STREET-CONTEXT GATE for the locality channel (2026-07-29, the 8.2.0 pre-ship gauntlet catch;
	// precedent: the #1315 FST street-context gate). Locality-surface evidence feeds ONLY when the
	// street painter found context on this input. On a bare place-name lookup ("Melbourne",
	// "Sydney, Australia") homograph-flagged locality evidence ROTATES the parse (locality → region/
	// street — the Washington-DC class, surviving in the fragment register on world-city homographs)
	// while the resolver already owns that register outright; withholding = the curriculum-trained
	// absence identity, the same declared-ablation semantics as formatted mode. Street-bearing
	// fragments — every measured win class (homonym/bare-street/particle rows all carry a street-type
	// word) — keep the full bundle. The street channel itself needs no gate: it paints nothing on a
	// street-word-less input by construction.
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
