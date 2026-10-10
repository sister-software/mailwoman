/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The classifier interface the geocode cascade consumes and the two helpers every geocode entry runs first.
 *   One helper selects the classifier that reads this input. A script-routed classifier handles the character-path
 *   family for a kanji or Hangul line. The other helper normalizes the input, including the postal-mark decision
 *   that must follow the classifier's encoder. These helpers live together so the three geocode entries agree.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { CaseNormalization, ClassifierOpts, InputMode } from "@mailwoman/core/pipeline"
import { normalize } from "@mailwoman/normalize"
import type { QueryShape } from "@mailwoman/query-shape"

/**
 * The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it).
 */
export interface GeocodeClassifier {
	/**
	 * Which encoder feeds the model.
	 *
	 * Absent reads as `sentencepiece`.
	 * The character path keeps the postal mark 〒 the normalizer otherwise strips:
	 * the CJK model was trained with it and misreads the prefecture boundary without it.
	 */
	encoder?: "sentencepiece" | "char"
	/**
	 * The classifier this text will run on, when the implementation routes by script
	 * (`ScriptRoutedClassifier`): a kanji or Hangul line answers the character-path family.
	 * Its `encoder` determines the postal-mark normalization.
	 * Absent = this classifier reads every input.
	 */
	forInput?(text: string): Promise<GeocodeClassifier>
	parse(
		text: string,
		opts?: {
			postcodeRepair?: boolean
			caseNormalization?: CaseNormalization
			queryShape?: QueryShape
			inputMode?: InputMode
			enforceWordConsistency?: ClassifierOpts["enforceWordConsistency"]
			/**
			 * The gazetteer FST prior.
			 *
			 * The classifier reads this from `opts` only, with no config fallback, unlike `placetypePair`.
			 * A path that cannot express the field never constructs the prior at all.
			 * Absent leaves the decode unchanged from before this option.
			 */
			fst?: ClassifierOpts["fst"]
			fstStreetMorphology?: ClassifierOpts["fstStreetMorphology"]
			fstStreetMorphologyOpts?: ClassifierOpts["fstStreetMorphologyOpts"]
			fstStreetContextPositiveScale?: number
			/**
			 * Venue-head lookups for the venue-head prior.
			 */
			venueHead?: import("@mailwoman/neural/venue/head-prior").VenueHeadLexiconLike
			venueHeadOpts?: import("@mailwoman/neural/venue/head-prior").VenueHeadPriorOpts
		}
	): Promise<AddressTree>
}

/**
 * The classifier that will read `input`: the routed one when the deps' classifier
 * routes by script, else itself.
 *
 * Every geocode entry resolves this first, so the postal-mark normalization
 * and the parse follow the same model.
 */
export async function classifierForInput(classifier: GeocodeClassifier, input: string): Promise<GeocodeClassifier> {
	return classifier.forInput ? classifier.forInput(input) : classifier
}

/**
 * The normalizer call every geocode entry shares, so the three call sites
 * cannot disagree about the postal mark.
 */
export function normalizeGeocodeInput(
	input: string,
	classifier: Pick<GeocodeClassifier, "encoder"> | undefined
): ReturnType<typeof normalize> {
	return normalize(input, {
		expandAbbreviations: true,
		locale: "und",
		postalMark: classifier?.encoder === "char" ? "keep" : "strip",
	})
}
