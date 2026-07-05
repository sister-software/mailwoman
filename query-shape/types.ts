/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Minimal character-range descriptor used internally. Compatible with `@mailwoman/core`'s `Span` class by shape —
 * consumers holding a `Span` can pass it where `SpanRange` is expected.
 */
export interface SpanRange {
	start: number
	end: number
	body: string
}

/** Per-token character classification. */
export type TokenCharacterClass = "digit" | "alpha" | "mixed" | "punct" | "cjk" | "cyrillic" | "arabic"

/** Whole-input character class — folded from `TokenCharacterClass`. */
export type CharacterClass = "numeric" | "alpha" | "alphanumeric" | "cjk" | "cyrillic" | "arabic" | "mixed"

/** Known-format identifier. The set is intentionally small + universal. */
export type KnownFormat =
	| "us_zip"
	| "us_zip4"
	| "uk_postcode"
	| "fr_postcode"
	| "ca_postcode"
	| "de_postcode"
	| "jp_postcode"
	| "nl_postcode"
	| "po_box"

/** Punctuation grammar separator between consecutive segments. */
export type SegmentSeparator = "comma" | "newline" | "tab" | "whitespace" | "japanese-style" | null

/** Whitespace pattern of the whole input. */
export type WhitespacePattern = "single" | "double" | "tab" | "mixed" | "none"

export interface TokenClass {
	span: SpanRange
	class: TokenCharacterClass
	length: number
}

export interface Segment {
	span: SpanRange
	body: string
	/** Position in the segment list, 0-indexed. */
	index: number
	/** The separator that preceded this segment, or `null` for the first segment. */
	separator: SegmentSeparator
}

export interface KnownFormatHit {
	format: KnownFormat
	span: SpanRange
	/** 0..1. Ambiguous patterns (`fr_postcode`/`de_postcode` overlap with `us_zip`) score lower. */
	confidence: number
}

/**
 * A detected region abbreviation (e.g., "DC", "NY", "CA"). Used by the locality soft prior to bias preceding place-name
 * tokens toward `B-locality`.
 */
export interface RegionAbbreviationHit {
	/** Character offset into the normalized input. */
	start: number
	/** The abbreviation text (e.g., "DC", "NY"). */
	span: string
}

/**
 * Structural snapshot of an input string, computed once at the boundary between Stage 1 and Stage 2 of the runtime
 * pipeline. Microseconds-cheap. Consumed by stages 2, 2.5, 3 (optional), and 6 as additional context.
 *
 * Bitter-lesson-safe: recognizes universal structural patterns (character class, punctuation, postcode shape) rather
 * than place-specific knowledge.
 */
export interface QueryShape {
	characterClass: CharacterClass
	tokenClasses: TokenClass[]
	segments: Segment[]
	knownFormats: KnownFormatHit[]
	/**
	 * Region abbreviation hits detected in the input. The locality soft prior uses these to bias preceding place-name
	 * tokens toward `B-locality` / `I-locality` during Viterbi decoding.
	 */
	regionAbbreviations: RegionAbbreviationHit[]
	totalLength: number
	whitespacePattern: WhitespacePattern
}

/**
 * Minimal shape that satisfies `computeQueryShape`'s input contract. The full `NormalizedInput` from
 * `@mailwoman/normalize` is structurally compatible — no import required.
 */
export interface NormalizedInputLite {
	normalized: string
	appliedLocale?: string
}

export interface ComputeQueryShapeOpts {
	/** Locale hint for segmentation grammar (default: comma-based Western). */
	locale?: string
}
