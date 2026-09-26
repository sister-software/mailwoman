/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Rule-based locale detection from `QueryShape` that uses only universal structural cues — script class and known postcode formats — never place-name dictionaries.
 */

import type { QueryShapeFormatsView } from "@mailwoman/query-shape"

/**
 * Confidence at or above which a known-format hit counts as unambiguous; ambiguous hits — a bare
 * 5-digit run, which reads as US, FR and DE alike — arrive at 0.6, so this cleanly separates them.
 */
const UNAMBIGUOUS_FORMAT_CONFIDENCE = 0.9

export interface LocaleCandidate {
	locale: string
	confidence: number
	reason: string
}

/**
 * Script-class scorer: the CJK character class cannot tell Japanese from Chinese
 * or Korean Han text, so a Chinese-script address reports `ja-JP` — a known limit
 * of the hint's interface rather than a routing choice.
 */
export function scoreByScript(shape: QueryShapeFormatsView): LocaleCandidate | null {
	switch (shape.characterClass) {
		case "cjk":
			return { locale: "ja-JP", confidence: 0.8, reason: "characterClass=cjk" }
		case "cyrillic":
			return { locale: "ru-RU", confidence: 0.85, reason: "characterClass=cyrillic" }
		case "arabic":
			return { locale: "ar", confidence: 0.85, reason: "characterClass=arabic" }
		default:
			return null
	}
}

/**
 * Postcode-format scorer: ambiguous 5-digit hits (`us_zip`/`fr_postcode`/`de_postcode` all matching
 * at confidence 0.6) are treated as low-confidence US, the most common 5-digit reading globally.
 */
export function scoreByPostcode(shape: QueryShapeFormatsView): LocaleCandidate | null {
	const unambiguous = shape.knownFormats.filter((f) => f.confidence >= UNAMBIGUOUS_FORMAT_CONFIDENCE)

	if (unambiguous.length) {
		const hit = unambiguous[0]!

		switch (hit.format) {
			case "us_zip4":
				return { locale: "en-US", confidence: 0.95, reason: `format=${hit.format}` }
			case "uk_postcode":
				return { locale: "en-GB", confidence: 0.95, reason: `format=${hit.format}` }
			case "ca_postcode":
				// Canadian postcodes admit both en-CA and fr-CA; this defaults to en-CA.
				return { locale: "en-CA", confidence: 0.9, reason: `format=${hit.format}` }
			case "jp_postcode":
				return { locale: "ja-JP", confidence: 0.95, reason: `format=${hit.format}` }
		}
	}

	const fivedigit = shape.knownFormats.find((f) => f.format === "us_zip" || f.format === "fr_postcode")

	if (fivedigit) {
		// US is the global plurality interpretation, so an ambiguous 5-digit hit returns en-US at low confidence.
		return { locale: "en-US", confidence: 0.5, reason: "ambiguous-5digit-postcode" }
	}

	return null
}

/**
 * Whole-input fallback that keeps the stage always-decisive: when no other rule
 * fires it returns en-US at low confidence rather than `null`.
 */
export function scoreFallback(_shape: QueryShapeFormatsView): LocaleCandidate {
	return { locale: "en-US", confidence: 0.3, reason: "fallback" }
}
