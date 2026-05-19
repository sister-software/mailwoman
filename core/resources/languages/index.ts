/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export * from "./types.gen.js"
import { Alpha2LabelMap, Alpha2LanguageCode, Alpha3bLabelMap, Alpha3bLanguageCode } from "./types.gen.js"

/**
 * Prefixed languages are those which use a street prefix instead of a suffix.
 */
export const prefixedLanguages: ReadonlySet<Alpha2LanguageCode | "all"> = new Set([
	Alpha2LanguageCode.French,
	Alpha2LanguageCode.Catalan,
	Alpha2LanguageCode.Spanish,
	Alpha2LanguageCode.Portuguese,
	Alpha2LanguageCode.Romanian,
	Alpha2LanguageCode.Polish,
])

/**
 * Type-predicate to determine if a string is a valid ISO 639-1 language code.
 */
export function isAlpha2LanguageCode(value: string): value is Alpha2LanguageCode {
	return Alpha2LabelMap.has(value as Alpha2LanguageCode)
}

/**
 * Type-predicate to determine if a string is a valid ISO 639-2 language code.
 */
export function isAlpha3bLanguageCode(value: string): value is Alpha3bLanguageCode {
	return Alpha3bLabelMap.has(value as Alpha3bLanguageCode)
}

/**
 * Pluck the language label from the language code.
 */
export function pluckLanguageLabel(languageCodeLike: string, fallback: string = languageCodeLike): string {
	if (isAlpha2LanguageCode(languageCodeLike)) {
		return Alpha2LabelMap.get(languageCodeLike)![0]!
	}

	if (isAlpha3bLanguageCode(languageCodeLike)) {
		return Alpha3bLabelMap.get(languageCodeLike)![0]!
	}

	return fallback
}
