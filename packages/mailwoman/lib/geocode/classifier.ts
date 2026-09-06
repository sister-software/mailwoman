/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The classifier contract the geocode cascade consumes, and the two helpers every geocode entry runs FIRST: which
 *   classifier will read this input (a script-routed one answers the character-path family for a kanji or Hangul
 *   line), and the normalizer call whose postal-mark decision must follow that classifier's encoder. They live
 *   together so the three geocode entries cannot disagree about either.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ClassifierOpts, InputMode } from "@mailwoman/core/pipeline"
import { normalize } from "@mailwoman/normalize"
import type { QueryShape } from "@mailwoman/query-shape"

/**
 * The minimal classifier surface the cascade needs (a `NeuralAddressClassifier` satisfies it).
 */
export interface GeocodeClassifier {
	/**
	 * Which encoder feeds the model. Absent reads as `sentencepiece`. The character path keeps the postal mark 〒 the
	 * normalizer otherwise strips: the CJK model was trained with it and misreads the prefecture boundary without it.
	 */
	encoder?: "sentencepiece" | "char"
	/**
	 * The classifier this text will run on, when the implementation routes by script (`ScriptRoutedClassifier`): a kanji
	 * or Hangul line answers the character-path family, whose `encoder` is what the postal-mark normalization must
	 * follow. Absent = this classifier reads every input.
	 */
	forInput?(text: string): Promise<GeocodeClassifier>
	parse(
		text: string,
		opts?: {
			postcodeRepair?: boolean
			normalizeCase?: boolean
			queryShape?: QueryShape
			inputMode?: InputMode
			enforceWordConsistency?: ClassifierOpts["enforceWordConsistency"]
			/**
			 * The gazetteer FST prior. The classifier reads this from `opts` ONLY — there is no config fallback, unlike
			 * `placetypePair` — so a path that cannot express the field does not merely weaken the prior, it never constructs
			 * it (#1497). Absent = byte-identical to the pre-#1497 decode.
			 */
			fst?: ClassifierOpts["fst"]
			fstStreetMorphology?: ClassifierOpts["fstStreetMorphology"]
			fstStreetMorphologyOpts?: ClassifierOpts["fstStreetMorphologyOpts"]
			fstStreetContextPositiveScale?: number
		}
	): Promise<AddressTree>
}

/**
 * The classifier that will read `input`: the routed one when the deps' classifier routes by script, else itself. Every
 * geocode entry resolves this FIRST, so the postal-mark normalization and the parse follow the same model.
 */
export async function classifierForInput(classifier: GeocodeClassifier, input: string): Promise<GeocodeClassifier> {
	return classifier.forInput ? classifier.forInput(input) : classifier
}

/**
 * The normalizer call every geocode entry shares, so the three call sites cannot disagree about the postal mark.
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
