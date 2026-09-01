/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import regenerate from "regenerate"

/**
 * A pattern matching combining diacritical marks, variation selectors, and other characters that are often used in text
 * normalization.
 */
const CombiningDiacriticalPattern = regenerate()
	.add(0x20_0d) // ZERO WIDTH JOINER (U+200D)
	.addRange(0x03_00, 0x03_6f) // Combining Diacritical Marks
	.addRange(0x1a_b0, 0x1a_ff) // Combining Diacritical Marks Extended
	.addRange(0x1d_c0, 0x1d_ff) // Combining Diacritical Marks Supplement
	.addRange(0x20_d0, 0x20_ff) // Combining Diacritical Marks for Symbols
	.addRange(0xfe_00, 0xfe_0f) // Variation Selectors
	.addRange(0xfe_20, 0xfe_2f) // Combining Half Marks
	.add(0x30_99) // Combining Dakuten
	.add(0x30_9a) // Combining Handakuten
	.toRegExp("g")

export interface TextNormalizerReplaceClause {
	from: string | RegExp
	to: string
}

export interface TextNormalizerInit {
	lowercase?: boolean
	removeAccents?: boolean
	removeHyphen?: boolean
	removeSpaces?: boolean
	minLength?: number
	maxLength?: number
	replace?: TextNormalizerReplaceClause[]
}

/**
 * Normalizes text values, i.e. removes superfluous characters such as accents, hyphens, and spaces.
 */
export class TextNormalizer implements TextNormalizerInit {
	public readonly lowercase: boolean
	public readonly removeAccents: boolean
	public readonly removeHyphen: boolean
	public readonly removeSpaces: boolean
	public readonly replace: TextNormalizerReplaceClause[]
	public readonly minLength?: number
	public readonly maxLength?: number

	constructor(init: TextNormalizerInit = {}) {
		this.lowercase = init.lowercase ?? false
		this.removeAccents = init.removeAccents ?? false
		this.removeHyphen = init.removeHyphen ?? false
		this.removeSpaces = init.removeSpaces ?? false
		this.replace = init.replace ?? []
		this.minLength = init.minLength
		this.maxLength = init.maxLength
	}

	/**
	 * Perform text normalization on a given input.
	 */
	public normalize(input: string): string {
		input = input.trim()

		for (const { from, to } of this.replace) {
			input = input.replace(from, to)
		}

		if (this.lowercase) {
			input = input.toLowerCase()
		}

		if (this.removeAccents) {
			input = input
				// We first normalize to NFKD to decompose any accented characters...
				.normalize("NFKD")
				// Then we remove the accented characters...
				.replace(CombiningDiacriticalPattern, "")
				// And finally we normalize to NFKC to recompose the string.
				.normalize("NFKC")
		}

		if (this.removeHyphen) {
			input = input.replaceAll("-", " ")
		}

		if (this.removeSpaces) {
			input = input.replaceAll(" ", "")
		}

		return input
	}

	/**
	 * Validate a given input against the defined validations.
	 */
	public validate(input: string): boolean {
		if (this.minLength && input.length < this.minLength) {
			return false
		}

		if (this.maxLength && input.length > this.maxLength) {
			return false
		}

		return true
	}

	public toJSON(): TextNormalizerInit {
		return {
			lowercase: this.lowercase,
			removeAccents: this.removeAccents,
			removeHyphen: this.removeHyphen,
			removeSpaces: this.removeSpaces,
			replace: this.replace,
			minLength: this.minLength,
			maxLength: this.maxLength,
		}
	}
}
