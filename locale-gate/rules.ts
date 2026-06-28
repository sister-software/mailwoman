/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based locale detection from `QueryShape`. Bitter-lesson-safe: only universal structural cues
 *   (script class + known postcode formats), never place-name dictionaries.
 *
 *   Scoring shape: each scorer returns `{ locale, confidence }` or null. The composer picks the
 *   highest-confidence non-null result; ties broken by scorer order (most-specific first).
 */

import type { QueryShapeLike } from "./types.js"

export interface LocaleCandidate {
	locale: string
	confidence: number
	reason: string
}

/**
 * Script-class scorer: maps the dominant character class to a default locale per script.
 *
 * - Cjk → ja-JP (only CJK locale we ship today; ko/zh would need their own weights)
 * - Cyrillic → ru-RU (not currently shipped; signal is still useful)
 * - Arabic → ar (similar)
 * - Alpha / alphanumeric / numeric → no script-based commit (other scorers decide)
 */
export function scoreByScript(shape: QueryShapeLike): LocaleCandidate | null {
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
 * Postcode-format scorer: maps a high-confidence postcode format hit to the country it implies.
 *
 * Ambiguous 5-digit hits (`us_zip`/`fr_postcode`/`de_postcode` all matching at confidence 0.6) are treated as
 * low-confidence US (the most common 5-digit reading globally) — the caller can override with `--locale
 * fr-FR`/`--locale de-DE` when the disambiguating context isn't in the string.
 */
export function scoreByPostcode(shape: QueryShapeLike): LocaleCandidate | null {
	// Prefer unambiguous (confidence ≥ 0.9) hits over ambiguous (0.6) — among them, pick the one
	// with the highest confidence + most-specific country mapping.
	const unambiguous = shape.knownFormats.filter((f) => f.confidence >= 0.9)

	if (unambiguous.length > 0) {
		// Pick the first unambiguous hit (callers typically have one postcode per address).
		const hit = unambiguous[0]!

		switch (hit.format) {
			case "us_zip4":
				return { locale: "en-US", confidence: 0.95, reason: `format=${hit.format}` }
			case "uk_postcode":
				return { locale: "en-GB", confidence: 0.95, reason: `format=${hit.format}` }
			case "ca_postcode":
				// Canadian — both en-CA and fr-CA possible. Default en-CA; FR caller can override.
				return { locale: "en-CA", confidence: 0.9, reason: `format=${hit.format}` }
			case "jp_postcode":
				return { locale: "ja-JP", confidence: 0.95, reason: `format=${hit.format}` }
		}
	}
	// Ambiguous 5-digit fallback.
	const fivedigit = shape.knownFormats.find((f) => f.format === "us_zip" || f.format === "fr_postcode")

	if (fivedigit) {
		// Low confidence — US is the global plurality interpretation. Returns en-US so a downstream
		// consumer without a stronger signal still gets a sensible default; alternatives surface FR/DE.
		return { locale: "en-US", confidence: 0.5, reason: "ambiguous-5digit-postcode" }
	}

	return null
}

/**
 * Whole-input fallback: when nothing else fires, return en-US at low confidence. Keeps the gate always-decisive (no
 * `null` to the caller, ever).
 */
export function scoreFallback(_shape: QueryShapeLike): LocaleCandidate {
	return { locale: "en-US", confidence: 0.3, reason: "fallback" }
}
