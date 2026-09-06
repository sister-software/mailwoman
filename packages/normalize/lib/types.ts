/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export interface SpanRange {
	start: number
	end: number
	body: string
}

/**
 * A single normalization step, as recorded on `NormalizedInput.transforms`.
 */
export type NormalizationTransform =
	| { kind: "nfc"; changed: boolean }
	| { kind: "case_fold"; locale: string }
	| { kind: "expand_abbreviation"; from: string; to: string; at: SpanRange }
	| { kind: "collapse_whitespace"; runs: number }
	| { kind: "normalize_punctuation"; replacements: number }
	| { kind: "space_after_comma"; inserted: number }
	| { kind: "normalize_cjk"; folded: number; stripped: number }

/**
 * Result of running `normalize()` on a raw input string.
 *
 * `offsetMap[i]` is the index in `raw` from which `normalized[i]` came. For multi-character source sequences (NFC
 * composition, whitespace collapse, abbreviation expansion), each output char points to the FIRST source char by
 * convention.
 */
export interface NormalizedInput {
	/**
	 * The input as the caller sent it.
	 */
	raw: string

	/**
	 * Canonical form, all transforms applied.
	 */
	normalized: string

	/**
	 * Ordered record of what was done.
	 */
	transforms: NormalizationTransform[]

	/**
	 * `normalized[i]` came from `raw[offsetMap[i]]`. Length === normalized.length.
	 */
	offsetMap: number[]

	/**
	 * The locale used for case-folding + abbreviation rules.
	 */
	appliedLocale?: string
}

export interface NormalizeOpts {
	/**
	 * Locale hint for case-folding + abbreviation dictionaries.
	 */
	locale?: string

	/**
	 * Apply locale-aware lowercasing. Default: false (preserve case for downstream consumers).
	 */
	caseFold?: boolean

	/**
	 * Expand known abbreviations (`St` → `Street`, `NW` → `Northwest`, etc.). Default: false.
	 */
	expandAbbreviations?: boolean

	/**
	 * Skip Unicode NFC. Only use for debugging — production callers should leave on.
	 */
	skipNFC?: boolean
	/**
	 * What the CJK pass does with the postal mark 〒 (U+3012). `strip` (the default) drops it: it is byte-fallback OOV for
	 * the SentencePiece tokenizer and fragments the digits after it. `keep` leaves it in place for a classifier whose
	 * vocabulary carries it — the character-path CJK model was trained with the mark in front of every postcode, and
	 * without it misreads the prefecture boundary (`885-0061 宮崎県都城市…` → prefecture `崎県都`).
	 */
	postalMark?: "strip" | "keep"
}
